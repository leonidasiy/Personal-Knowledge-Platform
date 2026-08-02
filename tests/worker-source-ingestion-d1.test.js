// @ts-check

import { D1SourceIngestionRepository } from "../worker/source-ingestion-d1.js";

/** @typedef {{ readonly bind: (...values: readonly (string | number | null)[]) => StatementPort, readonly first: () => Promise<unknown | null>, readonly all: () => Promise<{ readonly results: readonly unknown[] }>, readonly run: () => Promise<{ readonly success: boolean, readonly meta?: { readonly changes?: number } }> }} StatementPort */

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
}

class Statement {
  /** @type {readonly (string | number | null)[]} */
  bindings = [];
  /** @param {Database} database @param {string} query */
  constructor(database, query) { this.database = database; this.query = query; }
  /** @param {...(string | number | null)} values */
  bind(...values) { this.bindings = values; return this; }
  async run() { return this.database.run(this.query, this.bindings); }
  async first() { return this.database.first(this.query, this.bindings); }
  async all() { return { results: this.database.all(this.query, this.bindings) }; }
}

class Database {
  leaseChanges = 1;
  batchChanges = 1;
  failBatch = false;
  source = { state: "active", revision: 1 };
  metadataChanges = 1;
  /** @type {null | { cursor_version:number, next_ordinal:number, pages_processed:number, decoded_bytes:number, redirects:number, state:string }} */
  cursor = null;
  /** @type {{ ordinal:number, url:string, depth:number, state:string, discovered_from_url:string | null }[]} */
  frontier = [{ ordinal: 0, url: "https://publisher.example/course/", depth: 0, state: "pending", discovered_from_url: null }];
  /** @type {null | { job_id:string, source_id:string, source_revision:number, job_state:string, canonical_url:string, current_revision:number, source_state:string, adapter_json:string }} */
  runnable = { job_id: "job-a", source_id: "source-a", source_revision: 1, job_state: "pending", canonical_url: "https://publisher.example/course/", current_revision: 1, source_state: "active", adapter_json: JSON.stringify({ id: "public-site", version: "1", granularity: "site", capabilities: ["metadata", "bounded-ingestion"] }) };
  /** @type {StatementPort[][]} */
  batches = [];
  /** @param {string} query */
  prepare(query) { return new Statement(this, query); }
  /** @param {readonly StatementPort[]} statements */
  async batch(statements) {
    if (this.failBatch) throw new Error("Injected failure.");
    this.batches.push([...statements]);
    return statements.map((statement, index) => {
      const query = /** @type {Statement} */ (statement).query;
      const changes = index === 0 && query.startsWith("UPDATE source_ingestion_jobs SET state = 'leased'") ? this.leaseChanges : this.batchChanges;
      return { success: true, meta: { changes } };
    });
  }
  /** @param {string} query @param {readonly (string | number | null)[]} _bindings */
  run(query, _bindings) { return { success: true, meta: { changes: query.includes("state = 'failed'") ? this.metadataChanges : 1 } }; }
  /** @param {string} query @param {readonly (string | number | null)[]} _bindings */
  first(query, _bindings) {
    if (query.startsWith("SELECT j.job_id")) return this.runnable;
    if (query.startsWith("SELECT cursor_version")) return this.cursor;
    return this.source;
  }
  /** @param {string} query @param {readonly (string | number | null)[]} _bindings */
  all(query, _bindings) { return query.startsWith("SELECT ordinal") ? this.frontier : []; }
}

const lease = Object.freeze({ ownerId: "owner-a", jobId: "job-a", sourceId: "source-a", sourceRevision: 1, leaseToken: "lease-a", leasedAt: "2026-07-22T12:00:00.000Z", leaseExpiresAt: "2026-07-22T12:05:00.000Z" });

/** @returns {import("../src/features/source-library/ingestion-contracts.js").SourceIngestionCommit} */
function commit() {
  return {
    lease,
    crawlAssessment: { id: "crawl-a", ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, policyVersion: "bounded-v1", selectedDepth: 2, evidence: [], outcome: "eligible", assessedAt: "2026-07-22T12:00:00.000Z" },
    rightsAssessments: [{ id: "rights-a", ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, itemId: "item-a", itemVersionId: "version-a", capabilities: [{ capability: "storage", outcome: "allowed" }], evidence: [{ reference: "https://publisher.example/rights", observedAt: "2026-07-22T11:00:00.000Z" }], assessedAt: "2026-07-22T12:00:00.000Z", expiresAt: null }],
    items: [{ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, itemId: "item-a", versionId: "version-a", canonicalUrl: "https://publisher.example/item", title: "Item", description: "Description", contentDigest: "sha256:item", provenance: [{ method: "bounded-fetch", reference: "https://publisher.example/item" }], observedAt: "2026-07-22T12:00:00.000Z", publishedAt: null }],
    contentReferences: [{ id: "content-a", ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1, itemId: "item-a", itemVersionId: "version-a", objectKey: "owners/opaque/content-a", contentDigest: "sha256:item", rightsAssessmentId: "rights-a", state: "processing-ready", createdAt: "2026-07-22T12:01:00.000Z" }],
    state: "completed", stopReason: null, pagesProcessed: 1, decodedBytes: 1200, resumeCursor: null, committedAt: "2026-07-22T12:01:00.000Z",
  };
}

Deno.test("D1 ingestion loads only the authoritative owner-scoped runnable job", async () => {
  const database = new Database();
  let result = await new D1SourceIngestionRepository(database).loadRunnable({ ownerId: "owner-a", jobId: "job-a" });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.rootUrl, "https://publisher.example/course/");
    assertEquals(result.value.cursor.frontier[0].url, "https://publisher.example/course/");
  }
  database.runnable = null;
  result = await new D1SourceIngestionRepository(database).loadRunnable({ ownerId: "owner-b", jobId: "job-a" });
  if (result.ok) throw new Error("Expected failure.");
  assertEquals(result.error.kind, "IngestionJobNotFound");
});

Deno.test("D1 ingestion job loading names disabled, stale, and non-runnable state", async () => {
  const database = new Database();
  if (database.runnable === null) throw new Error("Expected runnable fixture.");
  const cases = [
    [{ ...database.runnable, source_state: "disabled" }, "IngestionSourceDisabled"],
    [{ ...database.runnable, current_revision: 2 }, "IngestionSourceRevisionStale"],
    [{ ...database.runnable, job_state: "completed" }, "IngestionJobLeaseConflict"],
  ];
  for (const [row, kind] of cases) {
    database.runnable = /** @type {typeof database.runnable} */ (row);
    const result = await new D1SourceIngestionRepository(database).loadRunnable({ ownerId: "owner-a", jobId: "job-a" });
    if (result.ok) throw new Error("Expected failure.");
    assertEquals(result.error.kind, kind);
  }
});

Deno.test("D1 ingestion blocks sources without persisted bounded-ingestion capability", async () => {
  const database = new Database();
  if (database.runnable === null) throw new Error("Expected runnable fixture.");
  database.runnable = {
    ...database.runnable,
    adapter_json: JSON.stringify({
      id: "central-search:youtube",
      version: "educational-v1",
      granularity: "video",
      capabilities: ["metadata", "manual-transcript"],
    }),
  };
  const result = await new D1SourceIngestionRepository(database).loadRunnable({
    ownerId: "owner-a",
    jobId: "job-a",
  });
  if (result.ok) throw new Error("Expected acquisition prohibition.");
  assertEquals(result.error.kind, "IngestionSourceAcquisitionProhibited");
  assertEquals(database.cursor, null);
});

Deno.test("D1 ingestion blocks metadata-only Taddy podcast feeds before acquisition", async () => {
  const database = new Database();
  if (database.runnable === null) throw new Error("Expected runnable fixture.");
  database.runnable = {
    ...database.runnable,
    adapter_json: JSON.stringify({
      id: "central-search:podcasts",
      version: "educational-v1",
      granularity: "feed",
      capabilities: ["metadata"],
    }),
  };
  const result = await new D1SourceIngestionRepository(database).loadRunnable({
    ownerId: "owner-a",
    jobId: "job-a",
  });
  if (result.ok) throw new Error("Expected acquisition prohibition.");
  assertEquals(result.error.kind, "IngestionSourceAcquisitionProhibited");
  assertEquals(database.cursor, null);
});

Deno.test("D1 ingestion lease is conditional on active source revision and pending work", async () => {
  const database = new Database();
  const cursor = { version: 1, nextOrdinal: 0, pagesProcessed: 0, decodedBytes: 0, redirects: 0, frontier: [{ ordinal: 0, url: "https://publisher.example/course/", depth: 0, state: /** @type {const} */ ("pending"), discoveredFromUrl: null }] };
  const result = await new D1SourceIngestionRepository(database).lease(lease, "{\"selectedDepth\":2}", cursor);
  assertEquals(result.ok, true);
  assertEquals(database.batches[0].length, 3);
});

Deno.test("D1 ingestion lease distinguishes disabled, stale, and conflicting work", async () => {
  const database = new Database();
  database.leaseChanges = 0;
  const cursor = { version: 1, nextOrdinal: 0, pagesProcessed: 0, decodedBytes: 0, redirects: 0, frontier: [{ ordinal: 0, url: "https://publisher.example/course/", depth: 0, state: /** @type {const} */ ("pending"), discoveredFromUrl: null }] };
  database.source = { state: "disabled", revision: 1 };
  let result = await new D1SourceIngestionRepository(database).lease(lease, "{}", cursor);
  if (result.ok) throw new Error("Expected failure.");
  assertEquals(result.error.kind, "IngestionSourceDisabled");
  database.source = { state: "active", revision: 2 };
  result = await new D1SourceIngestionRepository(database).lease(lease, "{}", cursor);
  if (result.ok) throw new Error("Expected failure.");
  assertEquals(result.error.kind, "IngestionSourceRevisionStale");
  database.source = { state: "active", revision: 1 };
  result = await new D1SourceIngestionRepository(database).lease(lease, "{}", cursor);
  if (result.ok) throw new Error("Expected failure.");
  assertEquals(result.error.kind, "IngestionJobLeaseConflict");
});

Deno.test("D1 ingestion commit conditionally appends immutable assessments and item versions", async () => {
  const database = new Database();
  const result = await new D1SourceIngestionRepository(database).commit(commit());
  assertEquals(result.ok, true);
  assertEquals(database.batches.length, 1);
  assertEquals(database.batches[0].length, 6);
  for (const statement of database.batches[0].slice(0, 5)) {
    const fixture = /** @type {Statement} */ (statement);
    assertEquals(fixture.query.includes("EXISTS"), true);
    assertEquals(fixture.query.includes("UPDATE source_item_versions"), false);
  }
});

Deno.test("D1 ingestion restores a persisted resume cursor and frontier", async () => {
  const database = new Database();
  database.cursor = { cursor_version: 3, next_ordinal: 1, pages_processed: 2, decoded_bytes: 800, redirects: 1, state: "ready" };
  database.frontier = [
    { ordinal: 0, url: "https://publisher.example/course/", depth: 0, state: "visited", discovered_from_url: null },
    { ordinal: 1, url: "https://publisher.example/course/lesson", depth: 1, state: "pending", discovered_from_url: "https://publisher.example/course/" },
  ];
  const result = await new D1SourceIngestionRepository(database).loadRunnable({ ownerId: "owner-a", jobId: "job-a" });
  if (!result.ok) throw new Error("Expected resumable job.");
  assertEquals(result.value.cursor.version, 3);
  assertEquals(result.value.cursor.frontier[1].state, "pending");
});

Deno.test("D1 ingestion records a rights failure without acquired content", async () => {
  const database = new Database();
  let result = await new D1SourceIngestionRepository(database).recordMetadataOnly(
    { ownerId: "owner-a", jobId: "job-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://publisher.example/course/", cursor: { version: 1, nextOrdinal: 0, pagesProcessed: 0, decodedBytes: 0, redirects: 0, frontier: [] } },
    "RightsRegistryRecordMissing",
    "2026-07-22T12:00:00.000Z",
  );
  assertEquals(result.ok, true);
  database.metadataChanges = 0;
  result = await new D1SourceIngestionRepository(database).recordMetadataOnly(
    { ownerId: "owner-a", jobId: "job-a", sourceId: "source-a", sourceRevision: 1, rootUrl: "https://publisher.example/course/", cursor: { version: 1, nextOrdinal: 0, pagesProcessed: 0, decodedBytes: 0, redirects: 0, frontier: [] } },
    "RightsRegistryRecordMissing",
    "2026-07-22T12:00:00.000Z",
  );
  if (result.ok) throw new Error("Expected metadata persistence failure.");
  assertEquals(result.error.kind, "RightsRegistryMetadataPersistenceFailed");
});

Deno.test("D1 ingestion commit reports lease and persistence failures without success", async () => {
  const database = new Database();
  database.batchChanges = 0;
  let result = await new D1SourceIngestionRepository(database).commit(commit());
  if (result.ok) throw new Error("Expected failure.");
  assertEquals(result.error.kind, "IngestionJobLeaseConflict");
  database.failBatch = true;
  result = await new D1SourceIngestionRepository(database).commit(commit());
  if (result.ok) throw new Error("Expected failure.");
  assertEquals(result.error.kind, "IngestionPersistenceFailed");
});
