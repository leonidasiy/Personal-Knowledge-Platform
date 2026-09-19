// @ts-check
import webPush from "web-push";
import { isReminderSubscription } from "./service.js";

/** @param {{publicKey:string,privateKey:string,subject:string,fetch:typeof fetch,allowedOrigins:readonly string[]}} configuration */
export function createWebPushSender(configuration) {
  if (
    !configuration || typeof configuration.fetch !== "function" ||
    !Array.isArray(configuration.allowedOrigins) ||
    !configuration.allowedOrigins.length
  ) throw new TypeError("ReminderTransportConfigurationInvalid");
  try {
    webPush.getVapidHeaders(
      configuration.allowedOrigins[0],
      configuration.subject,
      configuration.publicKey,
      configuration.privateKey,
      "aes128gcm",
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new TypeError("ReminderTransportConfigurationInvalid");
  }
  /** @param {unknown} subscription @param {unknown} payload */
  return async (subscription, payload) => {
    if (
      !isReminderSubscription(subscription, configuration.allowedOrigins) ||
      !payload || typeof payload !== "object" || Array.isArray(payload)
    ) throw new TypeError("ReminderTransportInputInvalid");
    const message = /** @type {Record<string,unknown>} */ (payload);
    if (
      Object.keys(message).some((key) =>
        !["type", "id", "expiresAt", "test"].includes(key)
      ) || message.type !== "daily-reminder" ||
      typeof message.id !== "string" ||
      !/^[a-zA-Z0-9:_-]{1,128}$/.test(message.id) ||
      typeof message.expiresAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
        message.expiresAt,
      ) || !Number.isFinite(Date.parse(message.expiresAt)) ||
      (message.test !== undefined && typeof message.test !== "boolean")
    ) throw new TypeError("ReminderTransportInputInvalid");
    const request = webPush.generateRequestDetails(
      subscription,
      JSON.stringify(message),
      {
        TTL: 3600,
        vapidDetails: {
          publicKey: configuration.publicKey,
          privateKey: configuration.privateKey,
          subject: configuration.subject,
        },
      },
    );
    const response = await configuration.fetch(request.endpoint, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    // Provider response bodies can contain capability URLs; never buffer or log.
    await response.body?.cancel();
    if (response.status === 404 || response.status === 410) return false;
    if (!response.ok) {
      throw new Error(`ReminderPushRejected:${response.status}`);
    }
    return true;
  };
}
