// @ts-check

import { D1KnowledgeWorkflowBackfillRepository } from "../worker/knowledge-workflow-backfill-d1.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

class Statement {
  /** @param {Database} database */
  constructor(database) { this.database = database; }
  /** @param {...(string | number | null)} _values */
  bind(..._values) { return this; }
  async first() { return this.database.rows.shift() ?? null; }
  async run() { return { success: true, meta: { changes: 1 } }; }
}
class Database {
  /** @type {Record<string, unknown>[]} */ rows = [];
  /** @param {string} _query */
  prepare(_query) { return new Statement(this); }
}

Deno.test("backfill D1 ledger reads a validated completion marker and writes idempotently", async () => {
  const database = new Database();
  const repository = new D1KnowledgeWorkflowBackfillRepository({ database, logger: () => {} });
  database.rows.push({ owner_id: "owner-a", backfill_key: "backfill-a", source_count: 1, run_ids_json: JSON.stringify(["run-a"]), created_at: "2026-08-17T00:00:00.000Z" });
  const read = await repository.read("owner-a", "backfill-a");
  assertEquals(read.ok, true);
  if (read.ok && read.value !== null) assertEquals(read.value.runIds[0], "run-a");
  const written = await repository.write({ ownerId: "owner-a", backfillKey: "backfill-a", sourceCount: 1, runIds: ["run-a"], createdAt: "2026-08-17T00:00:00.000Z" });
  assertEquals(written.ok, true);
});
