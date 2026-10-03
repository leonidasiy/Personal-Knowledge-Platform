// @ts-check
import { createReminderService } from "./service.js";
import { createWebPushSender } from "./transport.js";
import { createSourceNotificationService } from "./source-updates.js";

/** @typedef {{VAPID_PUBLIC_KEY?:unknown,VAPID_PRIVATE_KEY?:unknown,VAPID_SUBJECT?:unknown,REMINDER_PUSH_ORIGINS?:unknown}} ReminderEnvironment */
/** Composition boundary: configuration errors disable this feature, not learning.
 * @param {{environment:ReminderEnvironment,database:import('./service.js').Database,now:()=>Date,fetch:typeof fetch,logger:(entry:import('./service.js').ReminderLog)=>void}} input
 * @returns {ReturnType<typeof createReminderService> & {notifySource:ReturnType<typeof createSourceNotificationService>['notify']}} */
export function createReminderRuntime(
  { environment, database, now, fetch, logger },
) {
  try {
    const values = [
      environment.VAPID_PUBLIC_KEY,
      environment.VAPID_PRIVATE_KEY,
      environment.VAPID_SUBJECT,
    ];
    const configured = values.some((value) => value !== undefined);
    const parsed = environment.REMINDER_PUSH_ORIGINS === undefined
      ? []
      : JSON.parse(/** @type {string} */ (environment.REMINDER_PUSH_ORIGINS));
    if (
      !Array.isArray(parsed) || !parsed.every((origin) =>
        typeof origin === "string"
      ) || (configured && values.some((value) =>
        typeof value !== "string" || value.trim() === ""
      ))
    ) {
      throw new TypeError("ReminderConfigurationMissing");
    }
    const publicKey = configured
      ? /** @type {string} */ (environment.VAPID_PUBLIC_KEY)
      : null;
    const sender = configured
      ? createWebPushSender({
        publicKey: /** @type {string} */ (publicKey),
        privateKey: /** @type {string} */ (environment.VAPID_PRIVATE_KEY),
        subject: /** @type {string} */ (environment.VAPID_SUBJECT),
        allowedOrigins: parsed,
        fetch,
      })
      : null;
    const reminders = createReminderService({
      database,
      publicKey,
      allowedOrigins: parsed,
      now,
      logger,
      sender,
    });
    const sourceUpdates = createSourceNotificationService({database,now,allowedOrigins:parsed,logger,sender});
    return Object.freeze({...reminders,notifySource:sourceUpdates.notify});
  } catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof SyntaxError)) {
      throw error;
    }
    logger({
      event: "reminder-configuration-failure",
      failureKind: "ReminderConfigurationMissing",
    });
    /** @returns {Promise<import('./service.js').Result<never>>} */
    const unavailable = async () => ({
      ok: false,
      error: { kind: "ReminderConfigurationMissing" },
    });
    return {
      get: unavailable,
      save: unavailable,
      skip: unavailable,
      test: unavailable,
      run: unavailable,
      notifySource: unavailable,
    };
  }
}
