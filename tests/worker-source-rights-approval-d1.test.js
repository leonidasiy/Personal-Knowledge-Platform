// @ts-check

import { D1SourceRightsRegistry } from "../worker/source-rights-registry-d1.js";

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

function approval() {
  return {
    approvalId: "source-rights-approval:approval-1",
    registryId: "source-rights-registry:registry-1",
    ownerId: "owner-a",
    sourceId: "source-a",
    sourceRevision: 1,
    idempotencyKey: "rights-approval-1",
    canonicalRootUrl: "https://publisher.example/course/",
    registryVersion: "rights-policy-v1",
    capabilities: {
      storage: { outcome: "allowed", evidenceReference: "https://publisher.example/terms#storage", observedAt: "2026-07-22T10:00:00.000Z", expiresAt: "2026-08-22T10:00:00.000Z" },
      display: { outcome: "allowed", evidenceReference: "https://publisher.example/terms#display", observedAt: "2026-07-22T10:00:00.000Z", expiresAt: "2026-08-22T10:00:00.000Z" },
      transformation: { outcome: "allowed", evidenceReference: "https://publisher.example/terms#transformation", observedAt: "2026-07-22T10:00:00.000Z", expiresAt: "2026-08-22T10:00:00.000Z" },
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
    attributionText: "Publisher course",
    evidenceDigest: "sha256:evidence",
    assessorId: "rights-reviewer",
    assessorVersion: "rights-check-v1",
    observedAt: "2026-07-22T10:00:00.000Z",
    expiresAt: "2026-08-22T10:00:00.000Z",
    createdAt: now,
  };
}

class Statement {
  /** @type {readonly (string | number | null)[]} */
  bindings = [];
  /** @param {Database} database @param {string} query */
  constructor(database, query) {
    this.database = database;
    this.query = query;
  }
  /** @param {...(string | number | null)} values */
  bind(...values) {
    this.bindings = values;
    return this;
  }
  async first() { return this.database.first(this.query, this.bindings); }
  async all() { return { results: [] }; }
  async run() { return { success: true, meta: { changes: 1 } }; }
}

class Database {
  /** @type {{ canonical_url:string, revision:number, state:string } | null} */
  source = { canonical_url: "https://publisher.example/course/", revision: 1, state: "active" };
  /** @type {{ job_id:string, source_revision:number, state:string, stop_reason:string | null } | null} */
  job = { job_id: "source-job:a", source_revision: 1, state: "failed", stop_reason: "RightsRegistryRecordMissing" };
  /** @type {{ registry_id:string } | null} */
  activeRegistry = null;
  /** @type {{ command_fingerprint:string, result_json:string } | null} */
  audit = null;
  failBatch = false;
  /** @type {number | null} */
  requeueChanges = null;
  /** @type {Statement[][]} */
  batches = [];
  /** @param {string} query */
  prepare(query) { return new Statement(this, query); }
  /** @param {string} query @param {readonly (string | number | null)[]} _bindings */
  first(query, _bindings) {
    if (query.includes("source_rights_approval_audits")) return this.audit;
    if (query.includes("FROM library_sources")) return this.source;
    if (query.includes("FROM source_rights_registry")) return this.activeRegistry;
    if (query.includes("FROM source_ingestion_jobs")) return this.job;
    return null;
  }
  /** @param {readonly Statement[]} statements */
  async batch(statements) {
    if (this.failBatch) throw new Error("Injected transaction failure.");
    this.batches.push([...statements]);
    if (this.requeueChanges !== null) return statements.map(() => ({ success: true, meta: { changes: this.requeueChanges } }));
    return statements.map(() => ({ success: true, meta: { changes: 1 } }));
  }
}

/** @param {Database} database */
function subject(database) {
  return new D1SourceRightsRegistry({ database: /** @type {import("../worker/source-rights-registry-d1.js").D1DatabasePort} */ (/** @type {unknown} */ (database)), now: () => now, logger: () => {} });
}

Deno.test("rights approval atomically inserts the registry, requeues only the named missing-rights job, and records the audit", async () => {
  const database = new Database();
  const result = await subject(database).approve(approval(), "fingerprint-a");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.jobId, "source-job:a");
    assertEquals(result.value.requeued, true);
    assertEquals(result.value.reused, false);
  }
  assertEquals(database.batches.length, 1);
  assertEquals(database.batches[0].length, 3);
  assert(database.batches[0][0].query.includes("UPDATE source_ingestion_jobs SET state = 'pending'"), "The exact failed job must be requeued first in the transaction.");
  assert(database.batches[0][1].query.includes("INSERT INTO source_rights_registry") && database.batches[0][1].query.includes("WHERE EXISTS"), "The registry must be guarded by the successful requeue.");
  assert(database.batches[0][2].query.includes("INSERT INTO source_rights_approval_audits"), "The idempotency audit must be part of the transaction.");
});

Deno.test("rights approval names a zero-row requeue race without reporting a partial approval", async () => {
  const database = new Database();
  database.requeueChanges = 0;
  const result = await subject(database).approve(approval(), "fingerprint-a");
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "RightsApprovalPersistenceFailed");
  assertEquals(database.batches.length, 1);
});

Deno.test("rights approval does not retry pending, arbitrary failed, or absent jobs", async () => {
  for (const job of [
    { job_id: "source-job:a", source_revision: 1, state: "pending", stop_reason: null },
    { job_id: "source-job:a", source_revision: 1, state: "failed", stop_reason: "BrowserRunTimedOut" },
    null,
  ]) {
    const database = new Database();
    database.job = job;
    const result = await subject(database).approve(approval(), "fingerprint-a");
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.requeued, false);
    assertEquals(database.batches.length, 1);
    assertEquals(database.batches[0].length, 2);
  }
});

Deno.test("rights approval is owner-scoped and revision/state checked before persistence", async () => {
  const cases = [
    [null, "RightsApprovalSourceNotFound"],
    [{ canonical_url: "https://publisher.example/course/", revision: 2, state: "active" }, "RightsApprovalRevisionStale"],
    [{ canonical_url: "https://publisher.example/course/", revision: 1, state: "disabled" }, "RightsApprovalSourceDisabled"],
    [{ canonical_url: "https://publisher.example/other/", revision: 1, state: "active" }, "RightsApprovalRootMismatch"],
  ];
  for (const [source, kind] of cases) {
    const database = new Database();
    database.source = /** @type {typeof database.source} */ (source);
    const result = await subject(database).approve(approval(), "fingerprint-a");
    if (result.ok) throw new Error("Expected rights approval boundary failure.");
    assertEquals(result.error.kind, kind);
    assertEquals(database.batches.length, 0);
  }
});

Deno.test("rights approval replays an identical idempotency key and rejects a changed command", async () => {
  const database = new Database();
  const stored = { approvalId: "source-rights-approval:approval-1", registryId: "source-rights-registry:registry-1", sourceId: "source-a", sourceRevision: 1, jobId: "source-job:a", requeued: true, reused: false };
  database.audit = { command_fingerprint: "fingerprint-a", result_json: JSON.stringify(stored) };
  let result = await subject(database).approve(approval(), "fingerprint-a");
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.value.reused, true);
  assertEquals(database.batches.length, 0);

  result = await subject(database).approve(approval(), "fingerprint-b");
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "RightsApprovalIdempotencyConflict");
});

Deno.test("rights approval refuses conflicting active evidence and preserves the transaction boundary on failure", async () => {
  const database = new Database();
  database.activeRegistry = { registry_id: "existing-registry" };
  let result = await subject(database).approve(approval(), "fingerprint-a");
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "RightsApprovalEvidenceConflict");
  assertEquals(database.batches.length, 0);

  database.activeRegistry = null;
  database.failBatch = true;
  result = await subject(database).approve(approval(), "fingerprint-a");
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "RightsApprovalPersistenceFailed");
});
