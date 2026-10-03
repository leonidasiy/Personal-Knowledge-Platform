// @ts-check
import { isReminderDevice, isReminderSubscription } from "./service.js";

/** @typedef {import('./service.js').FailureKind} FailureKind */
/** @typedef {import('./service.js').PushPayload} PushPayload */
/** @typedef {{ownerId:string,runId:string,revision:number,kind:'source-ready'|'source-attention',occurredAt:string}} SourceNotification */
/** @typedef {()=>Promise<import('./service.js').Result<boolean>>} IsCurrent */
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is string} */
function identifier(value) {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= 256;
}
/** @param {unknown} value @returns {value is SourceNotification} */
export function isSourceNotification(value) {
  return record(value) &&
    Object.keys(value).sort().join() ===
      "kind,occurredAt,ownerId,revision,runId" &&
    identifier(value.ownerId) && identifier(value.runId) &&
    Number.isSafeInteger(value.revision) && Number(value.revision) > 0 &&
    (value.kind === "source-ready" || value.kind === "source-attention") &&
    typeof value.occurredAt === "string" &&
    Number.isFinite(Date.parse(value.occurredAt)) &&
    new Date(value.occurredAt).toISOString() === value.occurredAt;
}

/** @param {{database:import('./service.js').Database,now:()=>Date,allowedOrigins:readonly string[],logger:(entry:import('./service.js').ReminderLog)=>void,sender:((subscription:import('./service.js').Subscription,payload:PushPayload)=>Promise<boolean>)|null}} dependencies */
export function createSourceNotificationService(
  { database, now, allowedOrigins, logger, sender },
) {
  if (
    typeof database?.prepare !== "function" || typeof now !== "function" ||
    typeof logger !== "function" || !Array.isArray(allowedOrigins) ||
    (sender !== null && typeof sender !== "function")
  ) throw new TypeError("SourceNotificationDependenciesInvalid");
  /** @param {FailureKind} kind @returns {import('./service.js').Result<never>} */
  function failure(kind) {
    logger({ event: "source-notification-failure", failureKind: kind });
    return { ok: false, error: { kind } };
  }
  /** @param {unknown} command @param {IsCurrent} isCurrent @returns {Promise<import('./service.js').Result<{sent:number}>>} */
  async function notify(command, isCurrent) {
    logger({ event: "source-notification-entry" });
    if (!isSourceNotification(command) || typeof isCurrent !== "function") {
      return failure("ReminderCommandInvalid");
    }
    const instant = now();
    if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
      return failure("ReminderClockInvalid");
    }
    const age = instant.getTime() - Date.parse(command.occurredAt);
    if (age < 0) return failure("ReminderCommandInvalid");
    if (age >= 3_600_000) {
      logger({ event: "source-notification-expired" });
      return { ok: true, value: { sent: 0 } };
    }
    if (sender === null) return failure("ReminderConfigurationMissing");
    /** @type {FailureKind} */ let stage = "ReminderReadUnavailable";
    let sent = 0, failed = 0;
    try {
      const current = await isCurrent();
      if (!current.ok) return failure(current.error.kind);
      if (typeof current.value !== "boolean") {
        return failure("ReminderDataInvalid");
      }
      if (!current.value) {
        logger({ event: "source-notification-stale" });
        return { ok: true, value: { sent: 0 } };
      }
      // ponytail: personal-use recipient scan capped at 1000; queue fan-out before multi-user scale.
      const rows = await database.prepare(
        "SELECT device_id,revision,endpoint,p256dh,auth FROM daily_reminders WHERE owner_id=? AND enabled=1 ORDER BY device_id LIMIT 1001",
      ).bind(command.ownerId).all();
      if (!rows.success || !Array.isArray(rows.results)) {
        return failure("ReminderReadUnavailable");
      }
      if (rows.results.length > 1000) {
        return failure("ReminderCapacityExceeded");
      }
      for (const row of rows.results) {
        if (
          !record(row) || !isReminderDevice(row.device_id) ||
          !Number.isSafeInteger(row.revision) || Number(row.revision) <= 0
        ) return failure("ReminderDataInvalid");
        const subscription = {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        };
        if (!isReminderSubscription(subscription, allowedOrigins)) {
          return failure("ReminderDataInvalid");
        }
        stage = "ReminderReadUnavailable";
        const latest = await isCurrent();
        if (!latest.ok) return failure(latest.error.kind);
        if (typeof latest.value !== "boolean") {
          return failure("ReminderDataInvalid");
        }
        if (!latest.value) {
          logger({ event: "source-notification-stale", sent });
          return { ok: true, value: { sent } };
        }
        stage = "ReminderWriteUnavailable";
        const claim = await database.prepare(
          "INSERT INTO source_notification_deliveries(owner_id,run_id,revision,kind,device_id,status,updated_at) SELECT ?,?,?,?,device_id,'claimed',? FROM daily_reminders WHERE owner_id=? AND device_id=? AND revision=? AND enabled=1 ON CONFLICT(owner_id,run_id,revision,kind,device_id) DO NOTHING",
        )
          .bind(
            command.ownerId,
            command.runId,
            command.revision,
            command.kind,
            instant.toISOString(),
            command.ownerId,
            row.device_id,
            Number(row.revision),
          ).run();
        if (
          !claim.success || !Number.isSafeInteger(claim.meta?.changes) ||
          ![0, 1].includes(Number(claim.meta?.changes))
        ) return failure("ReminderWriteUnavailable");
        if (claim.meta?.changes === 0) continue;
        // Claim before IO: uncertain sends are never automatically repeated.
        let status = "sent";
        try {
          const accepted = await sender(subscription, {
            type: command.kind,
            id: crypto.randomUUID(),
            expiresAt: new Date(Date.parse(command.occurredAt) + 3_600_000)
              .toISOString(),
          });
          if (!accepted) status = "disabled-expired";
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          status = "delivery-failed";
        }
        const saved = await database.prepare(
          "UPDATE source_notification_deliveries SET status=?,updated_at=? WHERE owner_id=? AND run_id=? AND revision=? AND kind=? AND device_id=?",
        )
          .bind(
            status,
            now().toISOString(),
            command.ownerId,
            command.runId,
            command.revision,
            command.kind,
            row.device_id,
          ).run();
        if (!saved.success || saved.meta?.changes !== 1) {
          return failure("ReminderWriteUnavailable");
        }
        if (status === "disabled-expired") {
          const disabled = await database.prepare(
            "UPDATE daily_reminders SET enabled=0,last_status='disabled-expired',updated_at=? WHERE owner_id=? AND device_id=? AND revision=? AND enabled=1",
          )
            .bind(
              instant.toISOString(),
              command.ownerId,
              row.device_id,
              Number(row.revision),
            ).run();
          if (!disabled.success) return failure("ReminderWriteUnavailable");
        }
        if (status === "sent") sent++;
        if (status === "delivery-failed") failed++;
        logger({
          event: `source-notification-${status}`,
          ...(status === "delivery-failed"
            ? { failureKind: /** @type {const} */ ("ReminderDeliveryFailed") }
            : {}),
        });
      }
      if (failed) return failure("ReminderDeliveryFailed");
      logger({ event: "source-notification-success", sent });
      return { ok: true, value: { sent } };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return failure(stage);
    }
  }
  return Object.freeze({ notify });
}
