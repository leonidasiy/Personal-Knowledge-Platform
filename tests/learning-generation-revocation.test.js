// @ts-check

import { LearningRevocationService } from "../src/features/learning-generation/revocation.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
}

Deno.test("revocation service validates the command and delegates an owner-scoped fingerprint", async () => {
  /** @type {unknown} */
  let seen;
  const service = new LearningRevocationService({
    repository: { revoke: async (command, fingerprint) => { seen = { command, fingerprint }; return { ok: true, value: { changedGenerations: 1, changedUnits: 1, changedTasks: 1, tombstones: [], reused: false } }; } },
    now: () => "2026-08-12T12:03:00.000Z",
    logger: () => {},
  });
  const invalid = await service.revoke({ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 0, idempotencyKey: "revoke-a", reason: "withdrawn", revokedAt: "bad" });
  assertEquals(invalid.ok, false);
  if (!invalid.ok) assertEquals(invalid.error.kind, "LearningRevocationCommandInvalid");
  const result = await service.revoke({ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 2, idempotencyKey: "revoke-a", reason: "rights withdrawn", revokedAt: "2026-08-12T12:03:00.000Z" });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  if (seen === undefined) throw new Error("Expected repository command.");
  assertEquals(/** @type {{ command: { readonly ownerId: string, readonly sourceRevision: number }, fingerprint: string }} */ (seen).command.ownerId, "owner-a");
  assertEquals(/** @type {{ command: { readonly ownerId: string, readonly sourceRevision: number }, fingerprint: string }} */ (seen).command.sourceRevision, 2);
  assertEquals(typeof /** @type {{ fingerprint: string }} */ (seen).fingerprint, "string");
});

