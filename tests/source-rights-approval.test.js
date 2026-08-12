// @ts-check

import {
  SourceRightsApprovalService,
  validateRightsApprovalCommand,
} from "../src/features/source-library/rights-approval.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const now = "2026-07-22T12:00:00.000Z";

function command(overrides = {}) {
  return {
    ownerId: "owner-a",
    sourceId: "source-a",
    sourceRevision: 1,
    idempotencyKey: "rights-approval-1",
    canonicalRootUrl: "https://publisher.example/course/",
    registryVersion: "rights-policy-v1",
    attributionText: "Publisher course",
    evidenceDigest: "sha256:evidence",
    assessorId: "rights-reviewer",
    assessorVersion: "rights-check-v1",
    observedAt: "2026-07-22T10:00:00.000Z",
    expiresAt: "2026-08-22T10:00:00.000Z",
    capabilities: {
      storage: {
        outcome: "allowed",
        evidenceReference: "https://publisher.example/terms#storage",
        observedAt: "2026-07-22T10:00:00.000Z",
        expiresAt: "2026-08-22T10:00:00.000Z",
      },
      display: {
        outcome: "allowed",
        evidenceReference: "https://publisher.example/terms#display",
        observedAt: "2026-07-22T10:00:00.000Z",
        expiresAt: "2026-08-22T10:00:00.000Z",
      },
      transformation: {
        outcome: "allowed",
        evidenceReference: "https://publisher.example/terms#transform",
        observedAt: "2026-07-22T10:00:00.000Z",
        expiresAt: "2026-08-22T10:00:00.000Z",
      },
    },
    crawlEvidence: {
      robots: "allowed",
      robotsEvidenceReference: "https://publisher.example/robots.txt",
      terms: "allowed",
      termsEvidenceReference: "https://publisher.example/terms",
      access: "public",
      accessEvidenceReference: "https://publisher.example/course/",
      structuralEvidence: [],
    },
    ...overrides,
  };
}

/** @param {Partial<{ readonly createId: () => string }>} [overrides] */
function service(overrides = {}) {
  /** @type {{ command: unknown, fingerprint: string }[]} */
  const calls = [];
  const subject = new SourceRightsApprovalService({
    repository: {
      approve: async (record, fingerprint) => {
        calls.push({ command: record, fingerprint });
        return {
          ok: true,
          value: {
            approvalId: record.approvalId,
            registryId: record.registryId,
            sourceId: record.sourceId,
            sourceRevision: record.sourceRevision,
            jobId: "source-job:a",
            requeued: true,
            reused: false,
          },
        };
      },
    },
    createId: overrides.createId ?? (() => "generated-id"),
    now: () => now,
    logger: () => {},
  });
  return { subject, calls };
}

Deno.test("rights approval validates every required metadata and evidence field", () => {
  const missing = command();
  delete /** @type {Record<string, unknown>} */ (missing).attributionText;
  let result = validateRightsApprovalCommand(missing);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(/** @type {{ readonly field: string }} */ (/** @type {unknown} */ (result.error)).field, "attributionText");

  result = validateRightsApprovalCommand(command({
    capabilities: {
      ...command().capabilities,
      storage: { ...command().capabilities.storage, evidenceReference: "" },
    },
  }));
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(/** @type {{ readonly field: string }} */ (/** @type {unknown} */ (result.error)).field, "capabilities.storage.evidenceReference");

  result = validateRightsApprovalCommand(command({
    crawlEvidence: {
      ...command().crawlEvidence,
      accessEvidenceReference: "",
    },
  }));
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(/** @type {{ readonly field: string }} */ (/** @type {unknown} */ (result.error)).field, "crawlEvidence.accessEvidenceReference");
});

Deno.test("rights approval rejects denied, unknown, stale, and incomplete permission evidence", async () => {
  const denied = validateRightsApprovalCommand(command({
    capabilities: {
      ...command().capabilities,
      transformation: { ...command().capabilities.transformation, outcome: "denied" },
    },
  }));
  assertEquals(denied.ok, false);
  if (!denied.ok) {
    assertEquals(denied.error.kind, "RightsApprovalEvidenceNotPermitted");
    assertEquals(/** @type {{ readonly field: string }} */ (/** @type {unknown} */ (denied.error)).field, "capabilities.transformation");
  }

  const unknownAccess = validateRightsApprovalCommand(command({
    crawlEvidence: { ...command().crawlEvidence, access: "authentication-required" },
  }));
  assertEquals(unknownAccess.ok, false);
  if (!unknownAccess.ok) assertEquals(unknownAccess.error.kind, "RightsApprovalEvidenceNotPermitted");

  const expired = await service().subject.approve(command({ expiresAt: now }));
  assertEquals(expired.ok, false);
  if (!expired.ok) assertEquals(expired.error.kind, "RightsApprovalEvidenceExpired");

  const incomplete = validateRightsApprovalCommand(command({
    crawlEvidence: { ...command().crawlEvidence, terms: "unknown" },
  }));
  assertEquals(incomplete.ok, false);
  if (!incomplete.ok) assertEquals(incomplete.error.kind, "RightsApprovalEvidenceNotPermitted");
});

Deno.test("rights approval rejects content-bearing or browser-owned commands before persistence", async () => {
  const { subject, calls } = service();
  const withContent = command({ content: "private source body" });
  const result = await subject.approve(withContent);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "RightsApprovalCommandInvalid");
  assertEquals(calls.length, 0);

  const withoutOwner = { ...command() };
  delete /** @type {Record<string, unknown>} */ (withoutOwner).ownerId;
  const ownerResult = await subject.approve(withoutOwner);
  assertEquals(ownerResult.ok, false);
  if (!ownerResult.ok) assertEquals(/** @type {{ readonly field: string }} */ (/** @type {unknown} */ (ownerResult.error)).field, "ownerId");
  assertEquals(calls.length, 0);
});

Deno.test("rights approval rejects content-bearing nested evidence fields", () => {
  const nestedCapability = validateRightsApprovalCommand(command({
    capabilities: { ...command().capabilities, storage: { ...command().capabilities.storage, content: "source text" } },
  }));
  assertEquals(nestedCapability.ok, false);

  const nestedCrawl = validateRightsApprovalCommand(command({
    crawlEvidence: { ...command().crawlEvidence, content: "source text" },
  }));
  assertEquals(nestedCrawl.ok, false);

  const nestedStructural = validateRightsApprovalCommand(command({
    crawlEvidence: {
      ...command().crawlEvidence,
      structuralEvidence: [{ kind: "navigation", evidenceUrl: "https://publisher.example/course/", requiredDepth: 1, observedAt: "2026-07-22T10:00:00.000Z", content: "source text" }],
    },
  }));
  assertEquals(nestedStructural.ok, false);
});

Deno.test("rights approval normalizes metadata and generates server-owned registry identities", async () => {
  const { subject, calls } = service({ createId: (() => {
    const ids = ["approval-1", "registry-1"];
    return () => /** @type {string} */ (ids.shift());
  })() });
  const result = await subject.approve(command({
    canonicalRootUrl: "https://publisher.example/course",
    attributionText: "  Publisher course  ",
  }));
  assertEquals(result.ok, true);
  assertEquals(calls.length, 1);
  const record = /** @type {Record<string, unknown>} */ (calls[0].command);
  assertEquals(record.approvalId, "source-rights-approval:approval-1");
  assertEquals(record.registryId, "source-rights-registry:registry-1");
  assertEquals(record.canonicalRootUrl, "https://publisher.example/course");
  assertEquals(record.attributionText, "Publisher course");
  assertEquals(Object.hasOwn(record, "content"), false);
  assert(record.fingerprint === undefined, "The fingerprint must stay outside the persisted record.");
});
