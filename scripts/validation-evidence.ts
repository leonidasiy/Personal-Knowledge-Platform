import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import { closeSync, constants, fstatSync, fsyncSync, openSync } from "node:fs";
export type FailureKind =
  | "ConfigurationInvalid"
  | "ManifestInvalid"
  | "UnsafePath"
  | "SourceChanged"
  | "CopyFailed"
  | "PublicationFailed"
  | "PublicationIncomplete"
  | "ArtifactCorrupt"
  | "ReceiptConflict"
  | "ReceiptFailed"
  | "RetentionInvalid"
  | "RetentionReadFailed"
  | "CommandInvalid"
  | "RequestReadFailed";
export type Result<T> = { ok: true; value: T } | {
  ok: false;
  error: { kind: FailureKind; operation: string; message: string };
};
export interface Manifest {
  version: 1;
  files: { path: string; sha256: string }[];
}
export interface Publication {
  digest: string;
  path: string;
  receipt: string;
  reused: boolean;
}
export interface RetentionReport {
  destructive: false;
  cutoffAtMs: number;
  candidates: { path: string; lastActiveAtMs: number }[];
  preserved: { path: string; reason: string }[];
}
interface Config {
  sourceRoot: string;
  storeRoot: string;
  runId: string;
  nowMs: number;
  leaseUntilMs: number;
}
interface FileRecord {
  path: string;
  sha256: string;
  executable: boolean;
}
interface CapturedFile extends FileRecord {
  bytes: Uint8Array;
}
interface ObjectRecord {
  version: 1;
  kind: "snapshot" | "build";
  digest: string;
  createdAtMs: number;
  files: FileRecord[];
}
interface Receipt {
  version: 1;
  runId: string;
  kind: "snapshot" | "build";
  digest: string;
  createdAtMs: number;
  leaseUntilMs: number;
  target: string;
}
type Activity = { kind: "unknown" } | { kind: "active" } | {
  kind: "inactive";
  lastActiveAtMs: number;
};
interface RetentionConfig {
  evidenceRoot: string;
  nowMs: number;
  retentionDays: 30;
  protectedRoots: string[];
  receiptRoots: string[];
  entries: { path: string; activity: Activity }[];
  references: { target: string; source: string }[];
  leases: { target: string; owner: string; expiresAtMs: number }[];
}
class EvidenceFault extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly operation: string,
    message: string,
  ) {
    super(message);
    this.name = "EvidenceFault";
  }
}
function fail(kind: FailureKind, operation: string, message: string): never {
  throw new EvidenceFault(kind, operation, message);
}
function object(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function instant(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
function text(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function digest(v: unknown): v is string {
  return typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
}
function errorMessage(cause: unknown) {
  return cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : "Non-Error filesystem failure";
}
async function guarded<T>(
  action: () => Promise<T>,
): Promise<Result<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (cause) {
    if (cause instanceof EvidenceFault) {
      return {
        ok: false,
        error: {
          kind: cause.kind,
          operation: cause.operation,
          message: cause.message,
        },
      };
    }
    throw cause; // Unexpected programmer/invariant failures must not be disguised as input errors.
  }
}
async function io<T>(
  kind: FailureKind,
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (cause) {
    if (cause instanceof EvidenceFault) throw cause;
    fail(kind, operation, errorMessage(cause));
  }
}
function within(root: string, path: string) {
  const r = relative(root, path);
  return r === "" || !isAbsolute(r) && r !== ".." && !r.startsWith(".." + sep);
}
function intersects(a: string, b: string) {
  return within(a, b) || within(b, a);
}
function safeRelative(path: unknown): asserts path is string {
  if (
    !text(path) || path.includes("\\") || path.includes("\0") ||
    isAbsolute(path) ||
    path.split("/").some((p) =>
      !p || p === "." || p === ".." || p === ".git" || p === ".codex" ||
      p === ".agents" || p === ".private" || p.startsWith(".env")
    )
  ) {
    fail(
      "UnsafePath",
      "path",
      "Expected an explicit relative file path without traversal or private configuration",
    );
  }
}
function rootPath(path: unknown): asserts path is string {
  if (!text(path) || !isAbsolute(path) || resolve(path) !== path) {
    fail(
      "ConfigurationInvalid",
      "root",
      "Roots must be explicit normalized absolute paths",
    );
  }
}
async function safeDirectory(path: string, kind: FailureKind) {
  const parts = path.split(sep).filter(Boolean);
  let cursor: string = sep;
  for (const part of parts) {
    cursor = join(cursor, part);
    const info = await io(kind, "directory", () => lstat(cursor));
    if (info.isSymbolicLink()) {
      fail("UnsafePath", "directory", "Symlink directory is not permitted");
    }
    if (!info.isDirectory()) fail(kind, "directory", "Expected directory");
  }
  if (await io(kind, "directory-realpath", () => realpath(path)) !== path) {
    fail("UnsafePath", "directory", "Root resolution changed");
  }
}
async function makeDirectory(path: string, root: string) {
  if (!within(root, path)) {
    fail("UnsafePath", "mkdir", "Destination escapes root");
  }
  await safeDirectory(root, "PublicationFailed");
  let cursor = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      await mkdir(cursor);
    } catch (cause) {
      if (!object(cause) || cause.code !== "EEXIST") {
        fail("PublicationFailed", "mkdir", errorMessage(cause));
      }
    }
    await safeDirectory(cursor, "PublicationFailed");
    await syncDirectory(dirname(cursor), "PublicationFailed");
  }
}
async function readSafe(
  root: string,
  path: string,
  kind: FailureKind,
): Promise<{ bytes: Uint8Array; executable: boolean }> {
  return await io(kind, "read-capture", async () => {
    safeRelative(path);
    const full = join(root, path);
    await safeDirectory(dirname(full), kind);
    const before = await io(kind, "read-stat", () => lstat(full));
    if (before.isSymbolicLink()) {
      fail("UnsafePath", "read", "Symlink input is not permitted");
    }
    if (!before.isFile()) fail(kind, "read", "Expected regular file");
    const file = await io(
      kind,
      "open",
      () => open(full, constants.O_RDONLY | constants.O_NOFOLLOW),
    );
    try {
      const opened = fstatSync(file.fd);
      if (before.ino !== opened.ino || before.dev !== opened.dev) {
        fail("SourceChanged", "read", "Input identity changed");
      }
      const bytes = new Uint8Array(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!read.bytesRead) {
          fail("SourceChanged", "read", "Input truncated during capture");
        }
        offset += read.bytesRead;
      }
      const after = fstatSync(file.fd);
      const current = await lstat(full);
      await safeDirectory(dirname(full), kind);
      if (
        current.isSymbolicLink() || current.ino !== opened.ino ||
        current.dev !== opened.dev || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
        current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs
      ) fail("SourceChanged", "read", "Input changed during capture");
      return { bytes, executable: (opened.mode & 0o111) !== 0 };
    } finally {
      await file.close();
    }
  });
}
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
function parseConfig(input: unknown): Config {
  if (
    !object(input) || !text(input.runId) ||
    !/^[-a-zA-Z0-9_]{1,100}$/.test(input.runId) || !instant(input.nowMs) ||
    !instant(input.leaseUntilMs) || input.leaseUntilMs < input.nowMs
  ) {
    fail(
      "ConfigurationInvalid",
      "config",
      "Valid run ID, clock and lease expiry are required",
    );
  }
  rootPath(input.sourceRoot);
  rootPath(input.storeRoot);
  if (input.sourceRoot === input.storeRoot) {
    fail("UnsafePath", "config", "Source and evidence roots must differ");
  }
  return {
    sourceRoot: input.sourceRoot,
    storeRoot: input.storeRoot,
    runId: input.runId,
    nowMs: input.nowMs,
    leaseUntilMs: input.leaseUntilMs,
  };
}
function parseManifest(input: unknown): Manifest {
  if (
    !object(input) || input.version !== 1 || !Array.isArray(input.files) ||
    !input.files.length
  ) {
    fail(
      "ManifestInvalid",
      "manifest",
      "Version 1 nonempty exact-file manifest is required",
    );
  }
  const files: Manifest["files"] = [], seen = new Set<string>();
  for (const item of input.files) {
    if (!object(item) || !digest(item.sha256)) {
      fail("ManifestInvalid", "manifest", "Each entry requires SHA256");
    }
    safeRelative(item.path);
    if (seen.has(item.path)) {
      fail("ManifestInvalid", "manifest", "Duplicate file path");
    }
    seen.add(item.path);
    files.push({ path: item.path, sha256: item.sha256 });
  }
  return {
    version: 1,
    files: files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  };
}
async function captureTree(root: string): Promise<CapturedFile[]> {
  const files: CapturedFile[] = [];
  await safeDirectory(root, "CopyFailed");
  async function walk(directory: string) {
    await safeDirectory(directory, "CopyFailed");
    for (
      const entry of await io(
        "CopyFailed",
        "enumerate",
        () => readdir(directory, { withFileTypes: true }),
      )
    ) {
      const full = join(directory, entry.name),
        path = relative(root, full).split(sep).join("/");
      safeRelative(path);
      if (entry.isSymbolicLink()) {
        fail("UnsafePath", "enumerate", "Symlinks are not captured");
      }
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const data = await readSafe(root, path, "CopyFailed");
        files.push({ path, ...data, sha256: hash(data.bytes) });
      } else fail("CopyFailed", "enumerate", "Unsupported filesystem entry");
    }
  }
  await walk(root);
  if (!files.length) fail("CopyFailed", "capture", "Build must contain files");
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function fileRecords(files: CapturedFile[]): FileRecord[] {
  return files.map(({ path, sha256, executable }) => ({
    path,
    sha256,
    executable,
  }));
}
function contentDigest(files: FileRecord[]) {
  return hash(JSON.stringify(files));
}
function parseObject(input: unknown): ObjectRecord {
  if (
    !object(input) || input.version !== 1 ||
    !["snapshot", "build"].includes(String(input.kind)) ||
    !digest(input.digest) || !instant(input.createdAtMs) ||
    !Array.isArray(input.files) || !input.files.length
  ) fail("ArtifactCorrupt", "verify", "Invalid publication marker");
  const files: FileRecord[] = [];
  for (const item of input.files) {
    if (
      !object(item) || typeof item.executable !== "boolean" ||
      !digest(item.sha256)
    ) fail("ArtifactCorrupt", "verify", "Invalid artifact file record");
    safeRelative(item.path);
    files.push({
      path: item.path,
      sha256: item.sha256,
      executable: item.executable,
    });
  }
  if (contentDigest(files) !== input.digest) {
    fail("ArtifactCorrupt", "verify", "Publication digest mismatch");
  }
  return {
    version: 1,
    kind: input.kind as ObjectRecord["kind"],
    digest: input.digest,
    createdAtMs: input.createdAtMs,
    files,
  };
}
async function writeExclusive(
  root: string,
  path: string,
  bytes: Uint8Array | string,
  mode: number,
  kind: FailureKind,
) {
  safeRelative(path);
  await makeDirectory(dirname(join(root, path)), root);
  let file;
  try {
    file = await open(
      join(root, path),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode,
    );
  } catch (cause) {
    fail(
      kind === "ReceiptFailed" && object(cause) && cause.code === "EEXIST"
        ? "ReceiptConflict"
        : kind,
      "write-exclusive",
      errorMessage(cause),
    );
  }
  try {
    await io(kind, "write", () => file.writeFile(bytes));
    await io(kind, "sync", async () => fsyncSync(file.fd));
  } finally {
    await io(kind, "close", () => file.close());
  }
  await syncDirectory(dirname(join(root, path)), kind);
}
async function syncDirectory(path: string, kind: FailureKind) {
  await io(kind, "sync-directory", async () => {
    const fd = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  });
}
async function sealDirectories(path: string) {
  await safeDirectory(path, "PublicationFailed");
  for (
    const entry of await io(
      "PublicationFailed",
      "seal-list",
      () => readdir(path, { withFileTypes: true }),
    )
  ) {
    if (entry.isDirectory()) await sealDirectories(join(path, entry.name));
  }
  await io("PublicationFailed", "seal-directory", () => chmod(path, 0o555));
  await syncDirectory(path, "PublicationFailed");
}
async function atomicRecord(
  root: string,
  path: string,
  bytes: string,
  kind: FailureKind,
) {
  const temporary = "pending/" + randomUUID() + ".json";
  await writeExclusive(root, temporary, bytes, 0o444, kind);
  await makeDirectory(dirname(join(root, path)), root);
  try {
    await link(join(root, temporary), join(root, path));
  } catch (cause) {
    if (kind !== "ReceiptFailed" || !object(cause) || cause.code !== "EEXIST") {
      fail(kind, "publish-record", errorMessage(cause));
    }
    const old = await readSafe(root, path, "ReceiptFailed");
    if (new TextDecoder().decode(old.bytes) !== bytes) {
      fail(
        "ReceiptConflict",
        "receipt",
        "Run receipt already exists with different bindings",
      );
    }
  }
  await syncDirectory(dirname(join(root, path)), kind);
  // Only this invocation's freshly created staging link is removed; failed stages remain evidence.
  await io(kind, "retire-owned-stage", () => unlink(join(root, temporary)));
  await syncDirectory(dirname(join(root, temporary)), kind);
}
async function verifyObject(path: string, expected: ObjectRecord) {
  await safeDirectory(path, "ArtifactCorrupt");
  const markerBytes = await readSafe(
    path,
    "publication.json",
    "PublicationIncomplete",
  );
  const marker = await io(
    "ArtifactCorrupt",
    "marker-json",
    async () =>
      JSON.parse(new TextDecoder().decode(markerBytes.bytes)) as unknown,
  );
  const actual = parseObject(marker);
  if (
    actual.kind !== expected.kind || actual.digest !== expected.digest ||
    JSON.stringify(actual.files) !== JSON.stringify(expected.files)
  ) fail("ArtifactCorrupt", "verify", "Existing object conflicts with capture");
  const top = await io(
    "ArtifactCorrupt",
    "artifact-entries",
    () => readdir(path),
  );
  if (top.sort().join(",") !== "files,publication.json") {
    fail("ArtifactCorrupt", "verify", "Unexpected artifact entries");
  }
  let files: CapturedFile[];
  try {
    files = await captureTree(join(path, "files"));
  } catch (cause) {
    if (cause instanceof EvidenceFault && cause.kind === "UnsafePath") {
      throw cause;
    }
    fail("ArtifactCorrupt", "verify-bytes", errorMessage(cause));
  }
  if (JSON.stringify(fileRecords(files)) !== JSON.stringify(expected.files)) {
    fail("ArtifactCorrupt", "verify", "Published content is corrupt");
  }
}
async function publish(
  config: Config,
  kind: ObjectRecord["kind"],
  files: CapturedFile[],
): Promise<Publication> {
  const records = fileRecords(files),
    digest = contentDigest(records),
    parent = join(config.storeRoot, "objects", kind),
    path = join(parent, digest);
  await makeDirectory(parent, config.storeRoot);
  const marker: ObjectRecord = {
    version: 1,
    kind,
    digest,
    createdAtMs: config.nowMs,
    files: records,
  };
  let reused = false;
  try {
    await mkdir(path);
  } catch (cause) {
    if (!object(cause) || cause.code !== "EEXIST") {
      fail("PublicationFailed", "claim", errorMessage(cause));
    }
    reused = true;
  }
  if (reused) await verifyObject(path, marker);
  else {
    for (const file of files) {
      await writeExclusive(
        path,
        "files/" + file.path,
        file.bytes,
        file.executable ? 0o555 : 0o444,
        "PublicationFailed",
      );
    }
    await sealDirectories(join(path, "files"));
    // The marker is last: partially written objects cannot be reused or referenced by a receipt.
    await atomicRecord(
      config.storeRoot,
      relative(config.storeRoot, join(path, "publication.json")).split(sep)
        .join("/"),
      JSON.stringify(marker) + "\n",
      "PublicationFailed",
    );
    await verifyObject(path, marker);
    await io("PublicationFailed", "seal", () => chmod(path, 0o555));
    await syncDirectory(path, "PublicationFailed");
    await syncDirectory(parent, "PublicationFailed");
  }
  const receipt = join(
    config.storeRoot,
    "runs",
    config.runId + "-" + kind + ".json",
  );
  const record: Receipt = {
    version: 1,
    runId: config.runId,
    kind,
    digest,
    createdAtMs: config.nowMs,
    leaseUntilMs: config.leaseUntilMs,
    target: relative(config.storeRoot, path).split(sep).join("/"),
  };
  const encoded = JSON.stringify(record) + "\n";
  await makeDirectory(dirname(receipt), config.storeRoot);
  await atomicRecord(
    config.storeRoot,
    relative(config.storeRoot, receipt).split(sep).join("/"),
    encoded,
    "ReceiptFailed",
  );
  return { digest, path, receipt, reused };
}
export async function snapshot(input: unknown): Promise<Result<Publication>> {
  return guarded(async () => {
    const config = parseConfig(input),
      manifest = parseManifest(object(input) ? input.manifest : undefined);
    await safeDirectory(config.sourceRoot, "CopyFailed");
    await safeDirectory(config.storeRoot, "PublicationFailed");
    const files: CapturedFile[] = [];
    for (const item of manifest.files) {
      if (within(config.storeRoot, join(config.sourceRoot, item.path))) {
        fail(
          "UnsafePath",
          "snapshot",
          "Manifest cannot capture its evidence store",
        );
      }
      const data = await readSafe(config.sourceRoot, item.path, "CopyFailed");
      if (hash(data.bytes) !== item.sha256) {
        fail(
          "SourceChanged",
          "snapshot",
          "Manifest digest does not match input bytes",
        );
      }
      files.push({ ...item, ...data });
    }
    return await publish(config, "snapshot", files);
  });
}
export async function publishBuild(
  input: unknown,
): Promise<Result<Publication>> {
  return guarded(async () => {
    const config = parseConfig(input);
    const buildRoot = object(input) ? input.buildRoot : undefined;
    rootPath(buildRoot);
    if (intersects(buildRoot, config.storeRoot)) {
      fail("UnsafePath", "build", "Build and evidence roots must not overlap");
    }
    await safeDirectory(config.sourceRoot, "CopyFailed");
    await safeDirectory(config.storeRoot, "PublicationFailed");
    const files = await captureTree(buildRoot);
    if (
      contentDigest(fileRecords(files)) !==
        contentDigest(fileRecords(await captureTree(buildRoot)))
    ) fail("SourceChanged", "build", "Build changed during capture");
    return await publish(config, "build", files);
  });
}
function parseRetention(input: unknown): RetentionConfig {
  if (
    !object(input) || !instant(input.nowMs) || input.retentionDays !== 30 ||
    !Array.isArray(input.protectedRoots) || !input.protectedRoots.length ||
    !Array.isArray(input.receiptRoots) || !Array.isArray(input.entries) ||
    !Array.isArray(input.references) || !Array.isArray(input.leases)
  ) {
    fail(
      "RetentionInvalid",
      "retention",
      "Explicit clock, 30 days, protected roots and registry are required",
    );
  }
  rootPath(input.evidenceRoot);
  const protectedRoots: string[] = [];
  for (const p of input.protectedRoots) {
    rootPath(p);
    protectedRoots.push(p);
  }
  const receiptRoots: string[] = [];
  for (const p of input.receiptRoots) {
    rootPath(p);
    if (!within(input.evidenceRoot, p)) {
      fail(
        "RetentionInvalid",
        "receipt-roots",
        "Receipt roots must be within evidence root",
      );
    }
    receiptRoots.push(p);
  }
  const entries: RetentionConfig["entries"] = [], seen = new Set<string>();
  for (const e of input.entries) {
    if (
      !object(e) || !object(e.activity) ||
      !["unknown", "active", "inactive"].includes(String(e.activity.kind))
    ) fail("RetentionInvalid", "registry", "Invalid activity state");
    safeRelative(e.path);
    if (seen.has(e.path)) {
      fail("RetentionInvalid", "registry", "Duplicate evidence entry");
    }
    seen.add(e.path);
    let activity: Activity;
    if (e.activity.kind === "inactive") {
      if (
        !instant(e.activity.lastActiveAtMs) ||
        e.activity.lastActiveAtMs > input.nowMs
      ) fail("RetentionInvalid", "registry", "Invalid last activity clock");
      activity = {
        kind: "inactive",
        lastActiveAtMs: e.activity.lastActiveAtMs,
      };
    } else activity = { kind: e.activity.kind as "active" | "unknown" };
    entries.push({ path: e.path, activity });
  }
  const references: RetentionConfig["references"] = [];
  for (const r of input.references) {
    if (!object(r) || !text(r.source)) {
      fail("RetentionInvalid", "references", "Reference provenance required");
    }
    safeRelative(r.target);
    references.push({ target: r.target, source: r.source });
  }
  const leases: RetentionConfig["leases"] = [];
  for (const l of input.leases) {
    if (!object(l) || !text(l.owner) || !instant(l.expiresAtMs)) {
      fail("RetentionInvalid", "leases", "Invalid lease");
    }
    safeRelative(l.target);
    leases.push({
      target: l.target,
      owner: l.owner,
      expiresAtMs: l.expiresAtMs,
    });
  }
  return {
    evidenceRoot: input.evidenceRoot,
    nowMs: input.nowMs,
    retentionDays: 30,
    protectedRoots,
    receiptRoots,
    entries,
    references,
    leases,
  };
}
async function loadReceiptReferences(config: RetentionConfig) {
  for (const root of config.receiptRoots) {
    const directory = join(root, "runs");
    await safeDirectory(directory, "RetentionReadFailed");
    for (
      const entry of await io(
        "RetentionReadFailed",
        "receipt-list",
        () => readdir(directory),
      )
    ) {
      safeRelative(entry);
      const data = await readSafe(root, "runs/" + entry, "RetentionReadFailed");
      const r: unknown = await io(
        "RetentionReadFailed",
        "receipt-json",
        async () => JSON.parse(new TextDecoder().decode(data.bytes)) as unknown,
      );
      if (
        !object(r) || r.version !== 1 || !text(r.runId) ||
        !["snapshot", "build"].includes(String(r.kind)) || !digest(r.digest) ||
        !instant(r.createdAtMs) || !instant(r.leaseUntilMs) ||
        r.leaseUntilMs < r.createdAtMs
      ) fail("RetentionReadFailed", "receipt", "Invalid durable run receipt");
      safeRelative(r.target);
      if (
        r.target !== `objects/${r.kind}/${r.digest}` ||
        entry !== `${r.runId}-${r.kind}.json`
      ) fail("RetentionReadFailed", "receipt", "Receipt bindings conflict");
      const target = relative(config.evidenceRoot, join(root, r.target)).split(
          sep,
        ).join("/"),
        receipt = relative(config.evidenceRoot, join(directory, entry)).split(
          sep,
        ).join("/");
      safeRelative(target);
      safeRelative(receipt);
      config.references.push({ target, source: receipt });
      config.leases.push({
        target: receipt,
        owner: r.runId,
        expiresAtMs: r.leaseUntilMs,
      });
    }
  }
}
export async function reportRetention(
  input: unknown,
): Promise<Result<RetentionReport>> {
  return guarded(async () => {
    const config = parseRetention(input);
    await safeDirectory(config.evidenceRoot, "RetentionReadFailed");
    const cutoffAtMs = config.nowMs - config.retentionDays * 86400000;
    await loadReceiptReferences(config);
    const report: RetentionReport = {
      destructive: false,
      cutoffAtMs,
      candidates: [],
      preserved: [],
    };
    for (const entry of config.entries) {
      const path = join(config.evidenceRoot, entry.path);
      await safeDirectory(dirname(path), "RetentionReadFailed");
      const info = await io(
        "RetentionReadFailed",
        "evidence-stat",
        () => lstat(path),
      );
      let reason: string | undefined;
      if (info.isSymbolicLink()) reason = "symlink";
      else if (config.protectedRoots.some((p) => intersects(p, path))) {
        reason = "protected-root";
      } else if (
        config.references.some((r) =>
          intersects(join(config.evidenceRoot, r.target), path)
        )
      ) reason = "referenced";
      else if (
        config.leases.some((l) =>
          l.expiresAtMs > config.nowMs &&
          intersects(join(config.evidenceRoot, l.target), path)
        )
      ) reason = "live-lease";
      else if (entry.activity.kind !== "inactive") reason = entry.activity.kind;
      else if (
        config.entries.some((child) =>
          child.activity.kind !== "inactive" &&
          within(path, join(config.evidenceRoot, child.path))
        )
      ) reason = "active-or-unknown-descendant";
      else if (entry.activity.lastActiveAtMs > cutoffAtMs) {
        reason = "younger-than-30-days";
      }
      if (reason) report.preserved.push({ path: entry.path, reason });
      else if (entry.activity.kind === "inactive") {
        report.candidates.push({
          path: entry.path,
          lastActiveAtMs: entry.activity.lastActiveAtMs,
        });
      }
    }
    return report;
  });
}
export async function runCommand(
  mode: unknown,
  input: unknown,
): Promise<Result<Publication | RetentionReport>> {
  if (mode === "snapshot") return await snapshot(input);
  if (mode === "build") return await publishBuild(input);
  if (mode === "retention") return await reportRetention(input);
  return {
    ok: false,
    error: {
      kind: "CommandInvalid",
      operation: "command",
      message:
        "Use snapshot, build or retention; destructive cleanup is unavailable",
    },
  };
}
if (import.meta.main) {
  const [mode, request, ...extra] = Deno.args;
  let result: Result<Publication | RetentionReport>;
  if (extra.length || !request) {
    result = {
      ok: false,
      error: {
        kind: "CommandInvalid",
        operation: "cli",
        message: "Expected mode and explicit request JSON file",
      },
    };
  } else {result = await guarded(async () => {
      const loaded = await io(
        "RequestReadFailed",
        "request",
        async () => JSON.parse(await Deno.readTextFile(request)) as unknown,
      );
      const outcome = await runCommand(mode, loaded);
      if (!outcome.ok) {
        fail(
          outcome.error.kind,
          outcome.error.operation,
          outcome.error.message,
        );
      }
      return outcome.value;
    });}
  console.log(JSON.stringify(result));
  if (!result.ok) Deno.exit(1);
}
