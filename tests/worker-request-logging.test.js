// @ts-check

import { createDiscoveryRequestLogger } from "../worker/request-logging.js";
import { createDiscoveryWorker } from "../worker/handler.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
}
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {string} */
function resultErrorKind(value) {
  if (!record(value) || !record(value.error) || typeof value.error.kind !== "string") throw new Error("Expected a named request-log validation failure.");
  return value.error.kind;
}

Deno.test("discovery request logger emits allow-listed request and dependency lifecycle records", () => {
  /** @type {Record<string, unknown>[]} */ const records = [];
  const logger = createDiscoveryRequestLogger({
    sink: (entry) => records.push(entry),
    now: () => "2026-08-24T00:00:01.000Z",
  });
  logger(/** @type {never} */ ({ event: "request-entry", correlationId: "corr-1", route: "source-library-browse", method: "GET", cookie: "must-not-log" }));
  logger(/** @type {never} */ ({ event: "request-authenticated", correlationId: "corr-1", route: "source-library-browse", method: "GET", ownerId: "owner-a", email: "must-not-log" }));
  logger(/** @type {never} */ ({ event: "dependency-entry", correlationId: "corr-1", route: "source-library-browse", method: "GET", ownerId: "owner-a", operation: "source-catalog-browse", query: "must-not-log" }));
  logger(/** @type {never} */ ({ event: "dependency-success", correlationId: "corr-1", route: "source-library-browse", method: "GET", ownerId: "owner-a", operation: "source-catalog-browse", itemCount: 2, responseBody: "must-not-log" }));
  logger(/** @type {never} */ ({ event: "request-success", correlationId: "corr-1", route: "source-library-browse", method: "GET", ownerId: "owner-a", status: 200, sourceText: "must-not-log" }));
  assertEquals(records.length, 5);
  assertEquals(records[0].component, "discovery-worker");
  assertEquals(records[3].durationMs, 0);
  assertEquals(records[4].durationMs, 0);
  assertEquals("cookie" in records[0], false);
  assertEquals("email" in records[1], false);
  assertEquals("query" in records[2], false);
  assertEquals("responseBody" in records[3], false);
  assertEquals("sourceText" in records[4], false);
});

Deno.test("discovery success and failure logs retain IDs and named outcomes without content", () => {
  /** @type {Record<string, unknown>[]} */ const records = [];
  const logger = createDiscoveryRequestLogger({ sink: (entry) => records.push(entry), now: () => "2026-08-24T00:00:01.000Z" });
  logger(/** @type {never} */ ({ event: "request-success", correlationId: "corr-1", route: "knowledge-workflow", method: "POST", ownerId: "owner-a", runId: "run-a", status: 200, prompt: "private prompt", uploadedText: "private upload", extractedText: "private extraction", summary: "private summary", providerOutput: "private provider output" }));
  logger(/** @type {never} */ ({ event: "request-failure", correlationId: "corr-2", route: "knowledge-workflow", method: "POST", ownerId: "owner-a", runId: "run-a", status: 502, failureKind: "WorkflowBrowserFailed", prompt: "private prompt", uploadedText: "private upload", extractedText: "private extraction", summary: "private summary", providerOutput: "private provider output" }));
  assertEquals(records[0].ownerId, "owner-a");
  assertEquals(records[0].runId, "run-a");
  assertEquals(records[0].status, 200);
  assertEquals(records[1].ownerId, "owner-a");
  assertEquals(records[1].runId, "run-a");
  assertEquals(records[1].status, 502);
  assertEquals(records[1].failureKind, "WorkflowBrowserFailed");
  for (const record of records) for (const field of ["prompt", "uploadedText", "extractedText", "summary", "providerOutput"]) assertEquals(field in record, false);
});

Deno.test("discovery request logger rejects invalid categories and sensitive-shaped IDs", () => {
  const logger = createDiscoveryRequestLogger({ sink: () => {}, now: () => "2026-08-24T00:00:00.000Z" });
  assertEquals(resultErrorKind(logger(/** @type {never} */ ({ event: "unknown", correlationId: "corr-1", route: "other-api", method: "GET" }))), "DiscoveryRequestLogEntryInvalid");
  assertEquals(resultErrorKind(logger(/** @type {never} */ ({ event: "request-entry", correlationId: "token=secret", route: "other-api", method: "GET" }))), "DiscoveryRequestLogEntryInvalid");
});

Deno.test("production request logger adapter propagates typed logger failures as a dependency failure", async () => {
  const worker = createDiscoveryWorker({ allowedOrigin: "https://app.example", maximumCommandBytes: 4096 }, {
    authenticate: async () => ({ ok: true, value: { ownerId: "owner-a", email: "member@example.test" } }),
    acquireRss: async () => ({ ok: false, error: { kind: "DiscoveryFetchUnavailable" } }),
    createRequestId: () => "corr-logger",
    requestLogger: () => ({ ok: false, error: { kind: "DiscoveryRequestLogTimestampInvalid" } }),
  });
  const response = await worker.fetch(new Request("https://worker.example/api/discovery/rss", { method: "POST" }));
  assertEquals(response.status, 503);
  assertEquals((await response.json()).error, "DiscoveryRequestLoggingFailed");
});
