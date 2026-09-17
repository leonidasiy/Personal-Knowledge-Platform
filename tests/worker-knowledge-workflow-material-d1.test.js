// @ts-check

import { D1KnowledgeWorkflowMaterialRepository } from "../worker/knowledge-workflow-material-d1.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

class Statement {
  /** @param {Database} database @param {string} query */
  constructor(database, query) { this.database = database; this.query = query; }
  /** @param {...(string | number | null)} _values */
  bind(..._values) { return this; }
  async first() { return this.database.rows.shift() ?? null; }
  async run() { return { success: true, meta: { changes: 1 } }; }
}

class Database {
  /** @type {Record<string, unknown>[]} */ rows = [];
  /** @param {string} query */
  prepare(query) { return new Statement(this, query); }
}

const material = Object.freeze({
  ownerId: "owner-a",
  runId: "run-a",
  sourceId: "source-a",
  sourceRevision: 1,
  sourceUrl: "https://publisher.example/lesson",
  mediaType: "text/plain",
  fileName: "pasted-text.txt",
  contentDigest: "sha256:material-a",
  sections: Object.freeze([{ id: "text-1", title: "Concept", text: "A concept.", locator: "text:1" }]),
  media: Object.freeze([]),
  provenance: Object.freeze({ kind: "authorized-user-material", attestationReference: "attestation-a", basis: "text:learner copy" }),
});

/** @param {string} [fingerprint] */
function row(fingerprint = "fingerprint-a") {
  return { material_id: "material-a", idempotency_key: "material-key", command_fingerprint: fingerprint, object_key: "source-content/material-a", material_json: JSON.stringify(material), created_at: "2026-08-17T00:00:00.000Z" };
}

Deno.test("workflow material D1 repository reconstructs owner-scoped replay and read records", async () => {
  const database = new Database();
  database.rows.push(row());
  const repository = new D1KnowledgeWorkflowMaterialRepository({ database, logger: () => {} });
  const replay = await repository.replay("owner-a", "material-key");
  assertEquals(replay.ok, true);
  if (!replay.ok || replay.value === null) throw new Error("Expected replay.");
  assertEquals(replay.value.material.sections[0].text, "A concept.");
  database.rows.push({ ...row(), run_id: "run-a", owner_id: "owner-a" });
  const read = await repository.read("owner-a", "run-a");
  assertEquals(read.ok, true);
  if (read.ok && read.value !== null) assertEquals(read.value.materialId, "material-a");
});

Deno.test("workflow material D1 repository persists and removes one immutable record", async () => {
  const database = new Database();
  const repository = new D1KnowledgeWorkflowMaterialRepository({ database, logger: () => {} });
  const record = { materialId: "material-a", ownerId: "owner-a", runId: "run-a", idempotencyKey: "material-key", fingerprint: "fingerprint-a", objectKey: "source-content/material-a", material, createdAt: "2026-08-17T00:00:00.000Z" };
  const persisted = await repository.persist(record);
  assertEquals(persisted.ok, true);
  const removed = await repository.remove(record);
  assertEquals(removed.ok, true);
});
