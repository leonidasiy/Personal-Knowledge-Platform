// @ts-check
import { createSemanticRanker, SEMANTIC_RANKER_PROMPT_VERSION } from "../worker/local-semantic-index.js";
/** @param {boolean} condition @param {string} message */
function assert(condition, message) { if (!condition) throw new Error(message); }
const candidates = [{ id: "private-knowledge-id", sourceId: "private-source-id", sourceRevision: 3, title: "Harmony", text: "A cadence resolves tension." }];
/** @param {typeof fetch} fetcher */
function dependencies(fetcher) { return { apiKey: "test-key", fetch: fetcher, maximumCandidates: 20, timeoutMs: 3000, logger: (/** @type {unknown} */ _entry) => {} }; }
Deno.test("dedicated reranker sends text only and maps result indexes to local identities", async () => {
  const ranker = createSemanticRanker(dependencies(async (url, init) => {
    assert(String(url) === "https://openrouter.ai/api/v1/rerank", "Dedicated endpoint required.");
    assert(init?.method === "POST", "POST required.");
    assert(new Headers(init?.headers).get("Authorization") === "Bearer test-key", "Authentication required.");
    const body = JSON.parse(String(init?.body));
    assert(JSON.stringify(body) === JSON.stringify({ model: "cohere/rerank-4-fast", query: "harmonic resolution", documents: ["Harmony\nA cadence resolves tension."], top_n: 1 }), "Only approved text and ranking settings may leave the worker.");
    return Response.json({ results: [{ index: 0, relevance_score: 0.8 }] });
  }));
  const result = await ranker.rank({ query: "harmonic resolution", scope: "knowledge", limit: 1, candidates });
  assert(result.ok, "Ranker should succeed.");
  if (!result.ok) throw new Error(result.error.kind);
  assert(result.value.matches[0].id === "private-knowledge-id" && result.value.matches[0].score === 0.8, "Local index mapping required.");
  assert(result.value.modelId === "cohere/rerank-4-fast" && result.value.promptVersion === SEMANTIC_RANKER_PROMPT_VERSION, "Provenance required.");
});

Deno.test("reranker rejects invalid response indexes, scores and result counts with a named reason", async () => {
  for (const results of [[], [{ index: 1, relevance_score: 0.5 }], [{ index: -1, relevance_score: 0.5 }], [{ index: 0.5, relevance_score: 0.5 }], [{ index: "0", relevance_score: 0.5 }], [{ index: 0, relevance_score: "0.5" }], [{ index: 0, relevance_score: 2 }], [{ index: 0, relevance_score: null }], [{ index: 0, relevance_score: 0.5 }, { index: 0, relevance_score: 0.5 }], null]) {
    const ranker = createSemanticRanker(dependencies(async () => Response.json({ results })));
    const result = await ranker.rank({ query: "harmony", scope: "sources", limit: 1, candidates });
    assert(!result.ok && result.error.kind === "SourceSemanticIndexUnavailable" && result.error.reason === "InvalidResponse", "Invalid response must fail explicitly.");
  }
});

Deno.test("reranker cancels stalled fetch within its budget and logs no candidate content", async () => {
  let aborted = false;
  /** @type {unknown[]} */ const entries = [];
  const ranker = createSemanticRanker({ ...dependencies((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("Aborted", "AbortError")); });
    // A bounded fallback ensures this regression fails rather than hangs before implementation.
    setTimeout(() => reject(new TypeError("Fetch exceeded test deadline")), 30);
  })), timeoutMs: 5, logger: (entry) => entries.push(entry) });
  const result = await ranker.rank({ query: "harmony", scope: "sources", limit: 1, candidates });
  assert(!result.ok && result.error.kind === "SourceSemanticIndexUnavailable" && result.error.reason === "TimedOut" && aborted, "Timeout must cancel transport and return a named failure.");
  assert(JSON.stringify(entries).includes("semantic-ranker.started") && JSON.stringify(entries).includes("TimedOut") && !JSON.stringify(entries).includes("private-source-id") && !JSON.stringify(entries).includes("cadence"), "Safe entry/failure logging required.");
  await new Promise((resolve) => setTimeout(resolve, 35));
});

Deno.test("reranker rejects invalid and oversized commands without external processing", async () => {
  let calls = 0;
  const ranker = createSemanticRanker(dependencies(async () => { calls++; return Response.json({ results: [] }); }));
  for (const input of [null, { query: " ", scope: "sources", limit: 1, candidates }, { query: "harmony", scope: "sources", limit: 1, candidates: Array.from({ length: 21 }, (_, i) => ({ ...candidates[0], id: String(i) })) }, { query: "harmony", scope: "sources", limit: 1, candidates: [{ ...candidates[0], text: "x".repeat(12001) }] }]) {
    const result = await ranker.rank(input);
    assert(!result.ok && result.error.kind === "SourceSemanticIndexUnavailable" && result.error.reason === "InvalidCommand", "Invalid command must fail before fetch.");
  }
  assert(calls === 0, "Invalid commands must never leave the worker.");
});

Deno.test("reranker bounds provider response size and reports transport, HTTP and JSON failures", async () => {
  for (const [fetcher, reason] of /** @type {readonly [typeof fetch, string][]} */ ([
    [async () => { throw new TypeError("network"); }, "TransportFailed"],
    [async () => new Response("unavailable", { status: 503 }), "ProviderRejected"],
    [async () => new Response("bad JSON"), "InvalidResponse"],
    [async () => new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.5 }], padding: "x".repeat(65536) })), "InvalidResponse"],
  ])) {
    const result = await createSemanticRanker(dependencies(fetcher)).rank({ query: "harmony", scope: "sources", limit: 1, candidates });
    assert(!result.ok && result.error.kind === "SourceSemanticIndexUnavailable" && result.error.reason === reason, `Expected ${reason}.`);
  }
});

Deno.test("empty authorized candidate set returns empty matches without external processing", async () => {
  let called = false;
  const ranker = createSemanticRanker(dependencies(async () => { called = true; throw new Error("No request expected"); }));
  const result = await ranker.rank({ query: "harmony", scope: "sources", limit: 1, candidates: [] });
  assert(result.ok && result.value.matches.length === 0 && !called, "Empty library must remain a valid empty result.");
});

Deno.test("missing optional ranker credentials preserve startup and fail only requested ranking", async () => {
  let called = false;
  const ranker = createSemanticRanker({ ...dependencies(async () => { called = true; throw new Error("No request expected"); }), apiKey: null });
  const result = await ranker.rank({ query: "harmony", scope: "sources", limit: 1, candidates });
  assert(!result.ok && result.error.kind === "SourceSemanticIndexUnavailable" && result.error.reason === "NotConfigured" && !called, "Missing optional key must remain a named operation failure.");
});

Deno.test("handler deadline cancels ranking and expired requests never start inference", async () => {
  const controller = new AbortController();
  let aborted = false;
  let calls = 0;
  const ranker = createSemanticRanker(dependencies((_url, init) => new Promise((_resolve, reject) => {
    calls++;
    init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("Aborted", "AbortError")); });
    setTimeout(() => reject(new Error("Test deadline")), 30);
  })));
  const pending = ranker.rank({ query: "harmony", scope: "sources", limit: 1, candidates, signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert(!result.ok && result.error.kind === "SourceSemanticIndexUnavailable" && result.error.reason === "TimedOut" && aborted, "Handler cancellation must abort transport.");
  const expired = await ranker.rank({ query: "harmony", scope: "sources", limit: 1, candidates, signal: controller.signal });
  assert(!expired.ok && expired.error.kind === "SourceSemanticIndexUnavailable" && expired.error.reason === "TimedOut" && calls === 1, "Expired handler must not start inference.");
  await new Promise((resolve) => setTimeout(resolve, 35));
});
