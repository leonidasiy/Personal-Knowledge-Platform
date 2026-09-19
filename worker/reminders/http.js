// @ts-check
import { isReminderDevice } from "./service.js";
/** @param {unknown} value @param {number} [status] @param {Record<string,string>} [headers] */
function json(value, status = 200, headers = {}) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "private, no-store", ...headers },
  });
}
/** @param {string} kind */
function failure(kind) {
  const status =
    kind === "ReminderDeviceInvalid" || kind === "ReminderCommandInvalid"
      ? 400
      : kind === "ReminderConflict" || kind === "ReminderNotEnabled" ||
          kind === "ReminderSubscriptionRequired"
      ? 409
      : kind === "ReminderTestRateLimited"
      ? 429
      : kind === "ReminderRequestTooLarge"
      ? 413
      : kind === "ReminderDeliveryFailed"
      ? 502
      : 503;
  return json({ error: kind }, status);
}
/** Auth and same-origin policy are enforced by the parent HTTP router.
 * @param {Request} request @param {string} ownerId @param {ReturnType<import('./service.js').createReminderService>|null} service */
export async function handleReminderRequest(request, ownerId, service) {
  if (
    !(request instanceof Request) || typeof ownerId !== "string" ||
    !ownerId.trim()
  ) throw new TypeError("ReminderHttpDependenciesInvalid");
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "ReminderMethodNotAllowed" }, 405, {
      Allow: "GET, POST",
    });
  }
  const url = new URL(request.url);
  if (request.method === "GET") {
    const device = url.searchParams.get("deviceId");
    if (url.searchParams.size !== 1 || !isReminderDevice(device)) {
      return failure("ReminderDeviceInvalid");
    }
    if (service === null) return failure("ReminderReadUnavailable");
    const result = await service.get(ownerId, device);
    return result.ok
      ? json({ result: result.value })
      : failure(result.error.kind);
  }
  if (
    url.search ||
    request.headers.get("content-type")?.split(";")[0].trim() !==
      "application/json"
  ) return failure("ReminderCommandInvalid");
  const reader = request.body?.getReader();
  if (!reader) return failure("ReminderCommandInvalid");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        return failure("ReminderRequestTooLarge");
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return failure("ReminderCommandInvalid");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  /** @type {unknown} */ let command;
  try {
    command = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) {
      throw error;
    }
    return failure("ReminderCommandInvalid");
  }
  if (
    !command || typeof command !== "object" || Array.isArray(command) ||
    Object.hasOwn(command, "ownerId")
  ) return failure("ReminderCommandInvalid");
  const action = /** @type {{action?:unknown}} */ (command).action;
  if (action !== "save" && action !== "skip" && action !== "test") {
    return failure("ReminderCommandInvalid");
  }
  if (service === null) return failure("ReminderConfigurationMissing");
  const result = await service[action](ownerId, command);
  return result.ok
    ? json({ result: result.value })
    : failure(result.error.kind);
}
