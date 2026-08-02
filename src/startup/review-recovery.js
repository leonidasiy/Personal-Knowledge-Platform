// @ts-check

import { ReviewRecoveryService } from "../features/review-recovery/service.js";

/** @import { PersistenceEnvelope } from "../persistence/contracts.js" */

/**
 * @param {{
 *   readonly exportBackup: () => Promise<boolean>,
 *   readonly appendEnvelope: (envelope: PersistenceEnvelope, allowDuplicate: boolean) => Promise<boolean>,
 *   readonly location: { hash: string, reload: () => void }
 * }} dependencies
 */
export function createBrowserReviewRecovery(dependencies) {
  if (
    typeof dependencies.exportBackup !== "function" ||
    typeof dependencies.appendEnvelope !== "function" ||
    typeof dependencies.location?.reload !== "function"
  ) {
    throw new TypeError("Browser review recovery dependencies are invalid.");
  }
  return new ReviewRecoveryService({
    exportBackup: async () =>
      (await dependencies.exportBackup())
        ? { ok: true, value: /** @type {const} */ (true) }
        : {
          ok: false,
          error: { kind: /** @type {const} */ ("ReviewBackupExportFailed") },
        },
    prepareContinuation: () => ({
      ok: true,
      value: {
        commit: () => {
          dependencies.location.hash = "library/review-queue";
          dependencies.location.reload();
        },
      },
    }),
    persistQuarantine: async (quarantine) =>
      (await dependencies.appendEnvelope({
          id: quarantine.idempotencyKey,
          ownerId: quarantine.ownerId,
          kind: "review_quarantine",
          payloadJson: JSON.stringify(quarantine),
          recordedAt: quarantine.createdAt,
        }, false))
        ? { ok: true, value: /** @type {const} */ (true) }
        : {
          ok: false,
          error: {
            kind: /** @type {const} */ ("ReviewQuarantineWriteFailed"),
          },
        },
  });
}
