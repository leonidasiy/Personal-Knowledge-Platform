// @ts-check

import { createDeepSeekV4FlashAdapter } from "../worker/deepseek-v4-flash-adapter.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

function command() {
  return {
    sourceKind: "public-text",
    excerpt: "A piano has 88 keys.",
    unitIds: ["unit-a"],
    sourceAnchorIds: ["anchor-a"],
    instruction: "Return JSON with a tasks array. Do not include prose.",
    maximumOutputTokens: 120,
  };
}

Deno.test("DeepSeek adapter sends bounded JSON-mode non-thinking requests and parses typed usage", async () => {
  /** @type {Request[]} */
  const requests = [];
  /** @type {{ readonly event: string, readonly failureKind?: string, readonly durationMs?: number }[]} */
  const logs = [];
  const adapter = createDeepSeekV4FlashAdapter({
    apiKey: "secret-value-must-not-leak",
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-flash",
    maximumInputCharacters: 200,
    maximumOutputTokens: 500,
    timeoutMs: 1_000,
    now: () => 100,
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({
        id: "request-a",
        choices: [{
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: JSON.stringify({ tasks: [{ id: "task-a" }] }) },
        }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      });
    },
    logger: (entry) => logs.push(entry),
  });

  const result = await adapter.generate(command());
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.requestId, "request-a");
  assertEquals(result.value.usage.inputTokens, 12);
  assertEquals(result.value.usage.outputTokens, 8);
  assertEquals(result.value.drafts.length, 1);
  if (requests.length !== 1) throw new Error("Expected one provider request.");
  const captured = requests[0];
  const body = /** @type {{ readonly model: unknown, readonly thinking: unknown, readonly response_format: unknown, readonly stream: unknown }} */ (await captured.json());
  assertEquals(body.model, "deepseek-v4-flash");
  assertEquals((/** @type {{ readonly type: unknown }} */ (body.thinking)).type, "disabled");
  assertEquals((/** @type {{ readonly type: unknown }} */ (body.response_format)).type, "json_object");
  assertEquals(body.stream, false);
  assertEquals(JSON.stringify(body).includes("secret-value-must-not-leak"), false);
  assertEquals(JSON.stringify(logs).includes("secret-value-must-not-leak"), false);
});

Deno.test("DeepSeek adapter keeps credential, manual-content, rate-limit, and malformed failures distinct", async () => {
  let calls = 0;
  const base = {
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-v4-flash",
    maximumInputCharacters: 200,
    maximumOutputTokens: 500,
    timeoutMs: 10,
    now: () => 100,
    fetch: async () => {
      calls += 1;
      return new Response("not-json", { status: 429 });
    },
    logger: () => {},
  };
  const missing = await createDeepSeekV4FlashAdapter({ ...base, apiKey: null }).generate(command());
  assertEquals(missing.ok, false);
  if (!missing.ok) assertEquals(missing.error.kind, "LearningProviderCredentialMissing");
  assertEquals(calls, 0);

  const manual = await createDeepSeekV4FlashAdapter({ ...base, apiKey: "secret" }).generate({ ...command(), sourceKind: "manual-transcript" });
  assertEquals(manual.ok, false);
  if (!manual.ok) assertEquals(manual.error.kind, "LearningManualExternalProcessingProhibited");
  assertEquals(calls, 0);

  const limited = await createDeepSeekV4FlashAdapter({ ...base, apiKey: "secret" }).generate(command());
  assertEquals(limited.ok, false);
  if (!limited.ok) assertEquals(limited.error.kind, "LearningProviderRateLimited");
  assertEquals(calls, 1);

  const malformed = await createDeepSeekV4FlashAdapter({
    ...base,
    apiKey: "secret",
    fetch: async () => new Response("not-json", { status: 200 }),
  }).generate(command());
  assertEquals(malformed.ok, false);
  if (!malformed.ok) assertEquals(malformed.error.kind, "LearningProviderResponseInvalid");
});
