// @ts-check

import { createJevAnswerGrader, JEV_GRADER_CONFIGURATION } from "../worker/jev-answer-grader.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

/** @param {typeof fetch} fetcher */
function dependencies(fetcher) { return { apiKey: "synthetic-key", configuration: JEV_GRADER_CONFIGURATION, fetch: fetcher, timeoutMs: 1000, logger: () => {} }; }
/** @param {Record<string, number>} probabilities */
function response(probabilities) { return Response.json({ model: "typesafe/jev-1.13-20260917", answers: Object.fromEntries(Object.entries(probabilities).map(([id, probability]) => [id, { type: "noul", noul: probability }])), usage: { input_tokens: 5, output_tokens: 0 } }); }
function command() { return { prompt: "The tonal center is the ____. ", answers: [{ id: "blank-1", response: "home note", canonicalAnswers: ["tonic"] }] }; }

Deno.test("Jev grader sends only the bounded answer state and uses the latest Jev alias on the Decisions API", async () => {
  assertEquals(JEV_GRADER_CONFIGURATION.requestedModel, "~typesafe/jev-latest");
  assertEquals(JEV_GRADER_CONFIGURATION.servedModel, null);
  assertEquals(JEV_GRADER_CONFIGURATION.evidence, "https://openrouter.ai/docs/guides/community/jev-tutorial");
  /** @type {RequestInit | undefined} */ let request;
  const grader = createJevAnswerGrader(dependencies(async (input, init) => { assertEquals(String(input), "https://openrouter.ai/api/alpha/decisions"); request = init; return response({ "blank-1": 0.8 }); }));
  const result = await grader.grade(command());
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.accepted[0], true);
  assertEquals(result.value.probabilities[0], 0.8);
  assertEquals(result.value.model, "typesafe/jev-1.13-20260917");
  if (request?.body === undefined || typeof request.body !== "string") throw new Error("Expected bounded Decisions request.");
  assertEquals(request.redirect, "manual");
  const body = JSON.parse(request.body);
  assertEquals(body.model, "~typesafe/jev-latest");
  assertEquals(body.questions["blank-1"].type, "noul");
  assertEquals(body.questions["blank-1"].criteria.true.includes("without contradiction"), true);
  assertEquals(JSON.stringify(body.state), JSON.stringify({ prompt: command().prompt, answers: [{ id: "blank-1", response: "home note", canonicalAnswers: ["tonic"] }] }));
});

Deno.test("Jev grader applies the inclusive 0.70 boundary and rejects lower probability", async () => {
  for (const [probability, expected] of /** @type {readonly (readonly [number, boolean])[]} */ ([[0, false], [0.699999, false], [0.7, true], [0.75, true], [1, true]])) {
    const grader = createJevAnswerGrader(dependencies(async () => response({ "blank-1": probability })));
    const result = await grader.grade(command());
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.accepted[0], expected);
  }
});

Deno.test("Jev grader uses its injected served model and acceptance threshold", async () => {
  const configuration = Object.freeze({ ...JEV_GRADER_CONFIGURATION, requestedModel: "typesafe/jev-1.13", servedModel: "typesafe/jev-1.13-test", acceptanceThreshold: 0.9 });
  const grader = createJevAnswerGrader({ ...dependencies(async () => Response.json({ model: configuration.servedModel, answers: { "blank-1": { type: "noul", noul: 0.85 } } })), configuration });
  const result = await grader.grade(command());
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.model, configuration.servedModel);
    assertEquals(result.value.accepted[0], false);
  }
});

Deno.test("Jev grader reports missing credentials, timeout, rate limit, and malformed decisions distinctly", async () => {
  const missing = createJevAnswerGrader({ ...dependencies(fetch), apiKey: null });
  const missingResult = await missing.grade(command());
  assertEquals(missingResult.ok, false);
  if (!missingResult.ok) assertEquals(missingResult.error.kind, "JevCredentialMissing");
  const timeout = createJevAnswerGrader({ ...dependencies(async (_input, init) => await new Promise((_, reject) => /** @type {AbortSignal} */ (/** @type {RequestInit | undefined} */ (init)?.signal).addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }))), timeoutMs: 2 });
  const timeoutResult = await timeout.grade(command());
  assertEquals(timeoutResult.ok, false);
  if (!timeoutResult.ok) assertEquals(timeoutResult.error.kind, "JevTimeout");
  const limited = createJevAnswerGrader(dependencies(async () => new Response("{}", { status: 429 })));
  const limitedResult = await limited.grade(command());
  assertEquals(limitedResult.ok, false);
  if (!limitedResult.ok) assertEquals(limitedResult.error.kind, "JevRateLimited");
  const malformed = createJevAnswerGrader(dependencies(async () => Response.json({ answers: { "blank-1": { type: "noul", noul: 1.01 } } })));
  const malformedResult = await malformed.grade(command());
  assertEquals(malformedResult.ok, false);
  if (!malformedResult.ok) assertEquals(malformedResult.error.kind, "JevResponseInvalid");
});

Deno.test("Jev grader rejects invalid commands before calling the provider", async () => {
  let calls = 0;
  const grader = createJevAnswerGrader(dependencies(async () => { calls += 1; return response({}); }));
  const result = await grader.grade({ ...command(), answers: [] });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "JevCommandInvalid");
  assertEquals(calls, 0);
});

Deno.test("Jev grader accepts the quiz contract's twelve answer aliases without truncating them", async () => {
  const canonicalAnswers = Array.from({ length: 12 }, (_, index) => `valid wording ${index}`);
  let calls = 0;
  const grader = createJevAnswerGrader(dependencies(async (_input, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assertEquals(JSON.stringify(body.state.answers[0].canonicalAnswers), JSON.stringify(canonicalAnswers));
    return response({ "blank-1": 0.9 });
  }));
  const result = await grader.grade({ ...command(), answers: [{ ...command().answers[0], canonicalAnswers }] });
  assertEquals(result.ok, true);
  assertEquals(calls, 1);
  const invalid = await grader.grade({ ...command(), answers: [{ ...command().answers[0], canonicalAnswers: [...canonicalAnswers, "extra"] }] });
  assertEquals(invalid.ok, false);
  assertEquals(calls, 1);
});

Deno.test("Jev grader requires the evidence-backed served model identifier", async () => {
  const configuration = { ...JEV_GRADER_CONFIGURATION, requestedModel: "typesafe/jev-1.13", servedModel: "typesafe/jev-1.13-20260917" };
  const grader = createJevAnswerGrader({ ...dependencies(async () => Response.json({ model: "typesafe/jev-1.13", answers: { "blank-1": { type: "noul", noul: 0.99 } } })), configuration });
  const result = await grader.grade(command());
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "JevResponseInvalid");
});

Deno.test("Jev grader rejects duplicate JSON keys before parsing the decision", async () => {
  const grader = createJevAnswerGrader(dependencies(async () => new Response('{"model":"typesafe/jev-1.13-20260917","answers":{"blank-1":{"type":"noul","noul":0.99,"noul":0.01}}}', { headers: { "content-type": "application/json" } })));
  const result = await grader.grade(command());
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "JevResponseInvalid");
});

Deno.test("Jev latest accepts resolved versions without an obsolete snapshot pin", async () => {
  for (const model of ["typesafe/jev-1.13-20260917", "typesafe/jev-1.14-20261014", "typesafe/jev-2.0"]) {
    const grader = createJevAnswerGrader(dependencies(async () => Response.json({ model, answers: { "blank-1": { type: "noul", noul: 0.7 } } })));
    const result = await grader.grade(command());
    assertEquals(result.ok, true);
    if (result.ok) { assertEquals(result.value.model, model); assertEquals(result.value.accepted[0], true); }
  }
});

Deno.test("Jev latest rejects unrelated models and unbounded or missing probabilities", async () => {
  for (const model of ["z-ai/glm-5.3-flash", "typesafe/jev-router", "~typesafe/jev-latest", "", null]) {
    const grader = createJevAnswerGrader(dependencies(async () => Response.json({ model, answers: { "blank-1": { type: "noul", noul: 0.99 } } })));
    const result = await grader.grade(command());
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, "JevResponseInvalid");
  }
  for (const noul of [null, "0.7", -0.01, 1.01]) {
    const grader = createJevAnswerGrader(dependencies(async () => Response.json({ model: "typesafe/jev-1.13-20260917", answers: { "blank-1": { type: "noul", noul } } })));
    const result = await grader.grade(command());
    assertEquals(result.ok, false);
  }
});

Deno.test("Jev rejects provider redirects without following them or forwarding credentials", async () => {
  let calls = 0;
  const grader = createJevAnswerGrader(dependencies(async (_input, init) => {
    calls++;
    assertEquals(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://other.example.test/" } });
  }));
  const result = await grader.grade(command());
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "JevProviderRejected");
  assertEquals(calls, 1);
});
