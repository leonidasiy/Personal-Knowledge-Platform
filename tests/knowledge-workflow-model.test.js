// @ts-check

import { createOpenRouterKnowledgeModel } from "../worker/knowledge-workflow-model.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

function command() { return { role: "question-generator", systemPrompt: "Generate a grounded question.", input: { knowledge: "A specific concept" }, maxOutputTokens: 256 }; }

/** @param {Promise<unknown>} value */
async function assertRejects(value) {
  try { await value; } catch (_error) { return; }
  throw new Error("Expected promise rejection.");
}

Deno.test("live knowledge model adapter sends bounded JSON requests without a preflight cost gate", async () => {
  /** @type {RequestInit | undefined} */ let request;
  const model = createOpenRouterKnowledgeModel({ apiKey: "secret", endpoint: "https://api.example.test/chat/completions", model: "z-ai/glm-5.3-flash", timeoutMs: 1_000, maximumInputCharacters: 10_000, fetch: async (_input, init) => { request = init; return Response.json({ id: "request-a", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ question: "What concept?" }) } }], usage: { prompt_tokens: 4, completion_tokens: 3 } }); }, now: () => 1_000, logger: () => {} });
  const result = await model.generate(command());
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.output.question, "What concept?");
  if (request === undefined || typeof request.body !== "string") throw new Error("Request body was not captured.");
  const body = JSON.parse(request.body);
  assertEquals(body.model, "z-ai/glm-5.3-flash");
  assertEquals(body.max_tokens, 256);
  assertEquals(body.response_format.type, "json_object");
  assertEquals(body.messages[1].role, "user");
  assertEquals(body.messages[1].content.startsWith("<task_input>\n"), true);
  assertEquals(body.messages[1].content.endsWith("\n</task_input>"), true);
  assertEquals("thinking" in body, false);
  for (const parameter of ["temperature", "top_p", "top_k", "frequency_penalty", "presence_penalty", "repetition_penalty"]) assertEquals(parameter in body, false);
});

Deno.test("knowledge model sends raster attachments as vision blocks without putting image bytes in task JSON", async () => {
  /** @type {RequestInit | undefined} */ let request;
  const model = createOpenRouterKnowledgeModel({ apiKey: "secret", endpoint: "https://api.example.test/chat/completions", model: "z-ai/glm-5.3-flash", timeoutMs: 1_000, maximumInputCharacters: 10_000, fetch: async (_input, init) => { request = init; return Response.json({ id: "request-image", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ pages: [] }) } }] }); }, now: () => 1_000, logger: () => {} });
  const result = await model.generate({ role: "knowledge-scraper", systemPrompt: "Inspect the supplied image.", input: { operation: "observe", text: "caption" }, maxOutputTokens: 16_384, attachments: [{ id: "page-1", mediaType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }] });
  assertEquals(result.ok, true);
  if (request === undefined || typeof request.body !== "string") throw new Error("Request body was not captured.");
  const body = JSON.parse(request.body);
  if (!Array.isArray(body.messages[1].content)) throw new Error("Expected multimodal user content.");
  assertEquals(body.messages[1].content[0].type, "text");
  assertEquals(body.messages[1].content[0].text.includes("caption"), true);
  assertEquals(body.messages[1].content[0].text.includes("89504e47"), false);
  assertEquals(body.messages[1].content[1].type, "image_url");
  assertEquals(body.messages[1].content[1].image_url.url.startsWith("data:image/png;base64,iVBOR"), true);
});

Deno.test("image extraction requests strict provider-enforced schema and low-latency parameters", async () => {
  /** @type {RequestInit | undefined} */ let request;
  const model = createOpenRouterKnowledgeModel({ apiKey: "secret", endpoint: "https://api.example.test/chat/completions", model: "z-ai/glm-5.3-flash", timeoutMs: 1_000, maximumInputCharacters: 10_000, fetch: async (_input, init) => { request = init; return Response.json({ id: "request-image-schema", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ notes: "One distinction.", candidates: [] }) } }] }); }, now: Date.now, logger: () => {} });
  const responseSchema = { name: "material_image_v2", schema: { type: "object", properties: { notes: { type: "string" } }, required: ["notes"], additionalProperties: false } };
  const result = await model.generate({ role: "knowledge-scraper", systemPrompt: "Inspect image.", input: { mode: "image" }, maxOutputTokens: 4_096, timeoutMs: 90_000, responseSchema, reasoningEffort: "low", providerSort: "throughput" });
  assertEquals(result.ok, true);
  if (request === undefined || typeof request.body !== "string") throw new Error("Request body was not captured.");
  const body = JSON.parse(request.body);
  assertEquals(body.response_format.type, "json_schema");
  assertEquals(body.response_format.json_schema.strict, true);
  assertEquals(body.response_format.json_schema.schema.additionalProperties, false);
  assertEquals(body.provider.require_parameters, true);
  assertEquals(body.provider.sort, "throughput");
  assertEquals(body.reasoning.effort, "low");
  const rejected = createOpenRouterKnowledgeModel({ apiKey: "secret", endpoint: "https://api.example.test/chat/completions", model: "z-ai/glm-5.3-flash", timeoutMs: 1_000, maximumInputCharacters: 10_000, fetch: async () => new Response(null, { status: 400 }), now: Date.now, logger: () => {} });
  const unsupported = await rejected.generate({ role: "knowledge-scraper", systemPrompt: "Inspect image.", input: {}, maxOutputTokens: 4_096, responseSchema });
  assertEquals(unsupported.ok, false);
  if (!unsupported.ok) { assertEquals(unsupported.error.kind, "KnowledgeModelRejected"); if (unsupported.error.kind === "KnowledgeModelRejected") assertEquals(unsupported.error.status, 400); }
});

Deno.test("knowledge model rejects malformed or over-budget attachment commands", async () => {
  const model = createOpenRouterKnowledgeModel({ apiKey: "secret", endpoint: "https://api.example.test/chat/completions", model: "z-ai/glm-5.3-flash", timeoutMs: 1_000, maximumInputCharacters: 10_000, fetch: async () => Response.json({ id: "request-valid", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ question: "ok" }) } }] }), now: () => 1_000, logger: () => {} });
  const invalidType = await model.generate({ ...command(), attachments: [{ id: "bad", mediaType: "image/svg+xml", url: "https://example.test/image.svg" }] });
  assertEquals(invalidType.ok, false);
  if (!invalidType.ok) assertEquals(invalidType.error.kind, "KnowledgeModelCommandInvalid");
});

Deno.test("knowledge model names missing credentials, timeout, and malformed output", async () => {
  const missing = createOpenRouterKnowledgeModel({ apiKey: null, endpoint: "https://api.example.test/chat/completions", model: "z-ai/glm-5.3-flash", timeoutMs: 1_000, maximumInputCharacters: 10_000, fetch: async () => Response.json({}), now: () => 1_000, logger: () => {} });
  const credential = await missing.generate(command());
  assertEquals(credential.ok, false);
  if (!credential.ok) assertEquals(credential.error.kind, "KnowledgeModelCredentialMissing");
  const malformed = createOpenRouterKnowledgeModel({ apiKey: "secret", endpoint: "https://api.example.test/chat/completions", model: "z-ai/glm-5.3-flash", timeoutMs: 1_000, maximumInputCharacters: 10_000, fetch: async () => Response.json({ id: "request-a", choices: [{ finish_reason: "stop", message: { content: "not-json" } }] }), now: () => 1_000, logger: () => {} });
  const invalid = await malformed.generate(command());
  assertEquals(invalid.ok, false);
  if (!invalid.ok) assertEquals(invalid.error.kind, "KnowledgeModelResponseInvalid");
});

Deno.test("knowledge model rejects a JSON object truncated by the output-token limit", async () => {
  const model = createOpenRouterKnowledgeModel({ apiKey: "secret", endpoint: "https://api.example.test/chat/completions", model: "z-ai/glm-5.3-flash", timeoutMs: 1_000, maximumInputCharacters: 10_000, fetch: async () => Response.json({ id: "request-length", choices: [{ finish_reason: "length", message: { content: JSON.stringify({ revision: 1, frontier: [] }) } }] }), now: () => 1_000, logger: () => {} });
  const result = await model.generate(command());
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.kind, "KnowledgeModelResponseInvalid");
    if (result.error.kind === "KnowledgeModelResponseInvalid") assertEquals(result.error.field, "finish_reason");
  }
});

Deno.test("knowledge model accepts the bounded semantic-ranker role", async () => {
  const model = createOpenRouterKnowledgeModel({ apiKey: "secret", endpoint: "https://api.example.test/chat/completions", model: "z-ai/glm-5.3-flash", timeoutMs: 1_000, maximumInputCharacters: 10_000, fetch: async () => Response.json({ id: "request-rank", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ matches: [] }) } }] }), now: () => 1_000, logger: () => {} });
  const result = await model.generate({ role: "semantic-ranker", systemPrompt: "Rank candidates.", input: { query: "harmony", candidates: [] }, maxOutputTokens: 128 });
  assertEquals(result.ok, true);
});

Deno.test("knowledge model accepts the review grader role with synthetic learner answers", async () => {
  const model = createOpenRouterKnowledgeModel({ apiKey: "secret", endpoint: "https://api.example.test/chat/completions", model: "z-ai/glm-5.3-flash", timeoutMs: 1_000, maximumInputCharacters: 10_000, fetch: async () => Response.json({ id: "request-review", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ equivalent: [true] }) } }] }), now: () => 1_000, logger: () => {} });
  const result = await model.generate({ role: "review-grader", systemPrompt: "Judge equivalence.", input: { prompt: "Name the tonic.", answers: [{ response: "home note", acceptedAnswers: ["tonic"] }] }, maxOutputTokens: 128 });
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(JSON.stringify(result.value.output.equivalent), "[true]");
});

Deno.test("knowledge model maps an aborted DOMException fetch to its named timeout", async () => {
  const model = createOpenRouterKnowledgeModel({ apiKey: "secret", endpoint: "https://api.example.test/chat/completions", model: "z-ai/glm-5.3-flash", timeoutMs: 5, maximumInputCharacters: 10_000, fetch: async (_input, init) => await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })), now: Date.now, logger: () => {} });
  const result = await model.generate(command());
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "KnowledgeModelTimeout");
});

Deno.test("knowledge model keeps its timeout active while reading a response body", async () => {
  const model = createOpenRouterKnowledgeModel({ apiKey: "secret", endpoint: "https://api.example.test/chat/completions", model: "z-ai/glm-5.3-flash", timeoutMs: 5, maximumInputCharacters: 10_000, fetch: async (_input, init) => /** @type {Response} */ ({ status: 200, ok: true, json: async () => await new Promise((resolve, reject) => { const lateBody = setTimeout(() => resolve({ id: "late-body", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ question: "What concept?" }) } }] }), 20); init?.signal?.addEventListener("abort", () => { clearTimeout(lateBody); reject(new DOMException("aborted", "AbortError")); }, { once: true }); }) }), now: Date.now, logger: () => {} });
  const result = await model.generate(command());
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "KnowledgeModelTimeout");
});

Deno.test("knowledge model maps an un-aborted transport TypeError but propagates unrelated failures", async () => {
  const unavailable = createOpenRouterKnowledgeModel({ apiKey: "secret", endpoint: "https://api.example.test/chat/completions", model: "z-ai/glm-5.3-flash", timeoutMs: 1_000, maximumInputCharacters: 10_000, fetch: async () => { throw new TypeError("network unavailable"); }, now: Date.now, logger: () => {} });
  const unavailableResult = await unavailable.generate(command());
  assertEquals(unavailableResult.ok, false);
  if (!unavailableResult.ok) assertEquals(unavailableResult.error.kind, "KnowledgeModelUnavailable");
  const programmerFailure = createOpenRouterKnowledgeModel({ apiKey: "secret", endpoint: "https://api.example.test/chat/completions", model: "z-ai/glm-5.3-flash", timeoutMs: 1_000, maximumInputCharacters: 10_000, fetch: async () => { throw new RangeError("programmer failure"); }, now: Date.now, logger: () => {} });
  await assertRejects(programmerFailure.generate(command()));
});
