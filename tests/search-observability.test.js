// @ts-check

import { instrumentCentralSearch } from "../worker/search-observability.js";

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

Deno.test("central search observability logs only bounded lifecycle and failure categories", async () => {
  /** @type {unknown[]} */ const events = [];
  const search = instrumentCentralSearch({
    capabilities: () => [{ id: "podcasts", label: "Podcasts", resultKind: "podcast", priority: 1, enabled: true }],
    search: async (_command) => ({
      ok: false,
      error: {
        kind: "CentralSearchAllProvidersFailed",
        failures: [{
          providerId: "podcasts",
          failure: { kind: "SearchProviderQueryInvalid", reason: "field", diagnosticTokens: ["query", "field"], status: 400, secret: "must-not-log" },
        }],
      },
    }),
  }, (event) => events.push(event));

  const result = await search.search({ query: "private query", providerIds: ["podcasts"], limit: 5 });
  assert(!result.ok, "The wrapped failure must be preserved.");
  assert(JSON.stringify(events) === JSON.stringify([
    { event: "central-search-entry" },
    {
      event: "central-search-failure",
      failureKind: "CentralSearchAllProvidersFailed",
      providerFailureKinds: ["SearchProviderQueryInvalid"],
      providerFailureReasons: ["field"],
      providerDiagnosticTokens: ["query", "field"],
      upstreamStatuses: [],
    },
  ]), "Logs must contain only the closed failure evidence.");
  const serialized = JSON.stringify(events);
  assert(!serialized.includes("private query") && !serialized.includes("must-not-log") && !serialized.includes("podcasts"), "Logs must exclude request and provider identity data.");
});

Deno.test("central search observability records success without result content", async () => {
  /** @type {unknown[]} */ const events = [];
  const expected = { ok: /** @type {const} */ (true), value: { items: [{ title: "private title" }] } };
  const search = instrumentCentralSearch({ capabilities: () => [], search: async (_command) => expected }, (event) => events.push(event));
  const result = await search.search({ query: "private query" });
  assert(result === expected, "The wrapped success must preserve identity.");
  assert(JSON.stringify(events) === JSON.stringify([{ event: "central-search-entry" }, { event: "central-search-success" }]), "Success logs must be content-free.");
});
