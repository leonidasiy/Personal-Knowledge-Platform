// @ts-check

import { ReviewRecoveryService } from "../src/features/review-recovery/service.js";
import { createBrowserReviewRecovery } from "../src/startup/review-recovery.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

const command = Object.freeze({
  ownerId: "owner-a",
  recordIds: Object.freeze(["review-1", "review-2"]),
  idempotencyKey: "quarantine-1",
  createdAt: "2026-07-22T08:00:00.000Z",
  version: /** @type {const} */ (1),
});

Deno.test("review recovery exports, persists, and continues in order", async () => {
  /** @type {string[]} */
  const events = [];
  const service = new ReviewRecoveryService({
    exportBackup: async () => {
      events.push("export");
      return { ok: true, value: true };
    },
    prepareContinuation: () => {
      events.push("prepare-route");
      return {
        ok: true,
        value: { commit: () => events.push("continue-route") },
      };
    },
    persistQuarantine: async (quarantine) => {
      events.push(`persist:${quarantine.recordIds.length}`);
      return { ok: true, value: true };
    },
  });
  const recovered = await service.recover(command);
  assertEquals(recovered.ok, true);
  assertEquals(
    events.join(","),
    "export,prepare-route,persist:2,continue-route",
  );
});

Deno.test("review recovery is single-flight for repeated activation", async () => {
  let release = /** @type {(() => void) | null} */ (null);
  let exports = 0;
  let persists = 0;
  const service = new ReviewRecoveryService({
    exportBackup: () =>
      new Promise((resolve) => {
        exports += 1;
        release = () => resolve({ ok: true, value: true });
      }),
    prepareContinuation: () => ({
      ok: true,
      value: { commit: () => undefined },
    }),
    persistQuarantine: async () => {
      persists += 1;
      return { ok: true, value: true };
    },
  });
  const first = service.recover(command);
  const second = service.recover(command);
  assertEquals(first, second);
  assertEquals(exports, 1);
  if (release === null) throw new Error("Export did not start.");
  release();
  await first;
  assertEquals(persists, 1);
});

Deno.test("review recovery stops before persistence for backup or route failure", async () => {
  let persists = 0;
  const backupFailure = new ReviewRecoveryService({
    exportBackup: async () => ({
      ok: false,
      error: { kind: "ReviewBackupExportFailed" },
    }),
    prepareContinuation: () => {
      throw new Error("Route preparation must not run.");
    },
    persistQuarantine: async () => {
      persists += 1;
      return { ok: true, value: true };
    },
  });
  const failedBackup = await backupFailure.recover(command);
  assertEquals(failedBackup.ok, false);
  if (failedBackup.ok) throw new Error("Expected backup failure.");
  assertEquals(failedBackup.error.kind, "ReviewBackupExportFailed");

  const routeFailure = new ReviewRecoveryService({
    exportBackup: async () => ({ ok: true, value: true }),
    prepareContinuation: () => ({
      ok: false,
      error: { kind: "ReviewRecoveryRouteUnavailable" },
    }),
    persistQuarantine: async () => {
      persists += 1;
      return { ok: true, value: true };
    },
  });
  const failedRoute = await routeFailure.recover(command);
  assertEquals(failedRoute.ok, false);
  assertEquals(persists, 0);
});

Deno.test("review recovery persistence failure never continues", async () => {
  let continued = false;
  const service = new ReviewRecoveryService({
    exportBackup: async () => ({ ok: true, value: true }),
    prepareContinuation: () => ({
      ok: true,
      value: { commit: () => continued = true },
    }),
    persistQuarantine: async () => ({
      ok: false,
      error: { kind: "ReviewQuarantineWriteFailed" },
    }),
  });
  const failed = await service.recover(command);
  assertEquals(failed.ok, false);
  assertEquals(continued, false);
});

Deno.test("review recovery validates every public command field", async () => {
  const service = new ReviewRecoveryService({
    exportBackup: async () => ({ ok: true, value: true }),
    prepareContinuation: () => ({
      ok: true,
      value: { commit: () => undefined },
    }),
    persistQuarantine: async () => ({ ok: true, value: true }),
  });
  for (
    const [field, value] of [
      ["ownerId", { ...command, ownerId: "" }],
      ["recordIds", { ...command, recordIds: [] }],
      ["recordIds", { ...command, recordIds: ["review-1", "review-1"] }],
      ["idempotencyKey", { ...command, idempotencyKey: "" }],
      ["createdAt", { ...command, createdAt: "not-a-date" }],
      ["version", { ...command, version: 2 }],
    ]
  ) {
    const result = await service.recover(value);
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("Expected validation failure.");
    assertEquals(result.error.kind, "ReviewRecoveryCommandInvalid");
    if (result.error.kind !== "ReviewRecoveryCommandInvalid") continue;
    assertEquals(result.error.field, field);
  }
});

Deno.test("browser recovery composition reloads the Library Review queue", async () => {
  const location = {
    hash: "review",
    reloads: 0,
    reload() {
      this.reloads += 1;
    },
  };
  const state = {
    persisted:
      /** @type {import("../src/persistence/contracts.js").PersistenceEnvelope | null} */
      (null),
  };
  const recovery = createBrowserReviewRecovery({
    exportBackup: async () => true,
    appendEnvelope: async (envelope) => {
      state.persisted = envelope;
      return true;
    },
    location,
  });
  const result = await recovery.recover(command);
  assertEquals(result.ok, true);
  assertEquals(location.hash, "library/review-queue");
  assertEquals(location.reloads, 1);
  assertEquals(state.persisted?.kind, "review_quarantine");
});
