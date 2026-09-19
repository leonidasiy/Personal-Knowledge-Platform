// @ts-check

import { LearningBatchGatewayClient } from "../src/features/learning-generation/batches-gateway.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

/** @param {unknown} body @param {number} [status] */
function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const feed = {
  batch: { batchId: "feed:a", learningDay: "2026-08-19", status: "open", itemIds: ["k1", "k2", "k3", "k4", "k5"], revision: 1, createdAt: "2026-08-19T00:00:00.000Z", completedAt: null },
  items: Array.from({ length: 5 }, (_, index) => ({ knowledgeId: `k${index + 1}`, sourceId: "s1", questionId: `q${index + 1}`, title: "Music", summary: `Point ${index + 1}`, sourceUrl: "https://example.test", evidenceAnchorIds: ["anchor-1"], media: null, questionLocked: true })),
};

const review = {
  batch: { batchId: "review:a", learningDay: "2026-08-19", status: "open", itemIds: ["q1"], revision: 1, createdAt: "2026-08-19T00:00:00.000Z", completedAt: null },
  questions: [{ questionId: "q1", knowledgeId: "k1", title: "Music", prompt: "Which?", kind: "single-choice", choices: [{ id: "choice-1", label: "A" }, { id: "choice-2", label: "B" }], sourceAnchorIds: ["anchor-1"], revision: 1 }],
  dueCount: 1,
};

const fillBlankReview = {
  batch: { batchId: "review:fill", learningDay: "2026-08-19", status: "open", itemIds: ["q-fill"], revision: 1, createdAt: "2026-08-19T00:00:00.000Z", completedAt: null },
  questions: [{ questionId: "q-fill", knowledgeId: "k-fill", title: "Music", prompt: "Complete the term.", kind: "fill-blank", choices: null, sourceAnchorIds: ["anchor-1"], revision: 1 }],
  dueCount: 1,
};

Deno.test("learner gateway parses paired Feed and Review projections", async () => {
  /** @type {string[]} */ const paths = [];
  const gateway = new LearningBatchGatewayClient({
    fetch: async (input) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      paths.push(new URL(requestUrl).pathname);
      return response({ ownerId: "owner-a", result: paths.at(-1)?.endsWith("review-batch") ? review : feed });
    },
    baseUrl: "https://app.example.test/",
    timeoutMs: 1_000,
  });
  const loadedFeed = await gateway.loadFeed("2026-08-19");
  assertEquals(loadedFeed.ok, true);
  if (!loadedFeed.ok) return;
  assertEquals(loadedFeed.value.items.length, 5);
  const loadedReview = await gateway.loadReview("2026-08-19");
  assertEquals(loadedReview.ok, true);
  if (loadedReview.ok) {
    assertEquals(loadedReview.value.dueCount, 1);
    assertEquals(Object.hasOwn(loadedReview.value.questions[0] ?? {}, "explanation"), false);
    assertEquals(Object.hasOwn(loadedReview.value.questions[0] ?? {}, "correctChoiceIds"), false);
  }
});

Deno.test("learner gateway invokes injected fetch without rebinding its receiver", async () => {
  let requests = 0;
  const receiverSensitiveFetch = /** @type {typeof fetch} */ (
    /** @this {undefined} */ function (input, init) {
      if (this !== undefined) {
        return Promise.reject(new TypeError("Fetch receiver changed."));
      }
      requests += 1;
      return Promise.resolve(response({ ownerId: "owner-a", result: feed }));
    }
  );
  const gateway = new LearningBatchGatewayClient({
    fetch: receiverSensitiveFetch,
    baseUrl: "https://app.example.test/",
    timeoutMs: 1_000,
  });

  const loaded = await gateway.loadFeed("2026-08-19");
  assertEquals(loaded.ok, true);
  assertEquals(requests, 1);
});

Deno.test("learner gateway rejects pre-attempt projections that contain explanations or answer keys", async () => {
  const gateway = new LearningBatchGatewayClient({
    fetch: async () => response({ result: { ...review, questions: [{ ...review.questions[0], correctChoiceIds: ["choice-1"] }] } }),
    baseUrl: "https://app.example.test/",
    timeoutMs: 1_000,
  });
  const loaded = await gateway.loadReview("2026-08-19");
  assertEquals(loaded.ok, false);
  if (!loaded.ok) assertEquals(loaded.error.kind, "LearningBatchGatewayResponseInvalid");
  const explanationGateway = new LearningBatchGatewayClient({
    fetch: async () => response({ result: { ...review, questions: [{ ...review.questions[0], explanation: "Answer cue." }] } }),
    baseUrl: "https://app.example.test/",
    timeoutMs: 1_000,
  });
  const withExplanation = await explanationGateway.loadReview("2026-08-19");
  assertEquals(withExplanation.ok, false);
});

Deno.test("learner gateway parses answerable fill-blank Review questions", async () => {
  const gateway = new LearningBatchGatewayClient({
    fetch: async () => response({ ownerId: "owner-a", result: fillBlankReview }),
    baseUrl: "https://app.example.test/",
    timeoutMs: 1_000,
  });
  const loaded = await gateway.loadReview("2026-08-19");
  assertEquals(loaded.ok, true);
  if (loaded.ok) {
    assertEquals(loaded.value.questions[0]?.kind, "fill-blank");
    assertEquals(loaded.value.questions[0]?.choices, null);
  }
});

Deno.test("learner gateway keeps multi-blank answer keys private and parses scored feedback", async () => {
  const multi = { ...fillBlankReview, questions: [{ ...fillBlankReview.questions[0], blanks: [{ id: "blank-1" }, { id: "blank-2" }] }] };
  const gateway = new LearningBatchGatewayClient({ fetch: async (input) => String(input).includes("review-batch/answer") ? response({ result: { completed: true, correct: false, score: 0.5, nextDueAt: "2026-08-20T00:00:00.000Z", feedback: { explanation: "The source distinguishes both terms.", correctAnswer: "dominant, tonic", components: [{ id: "blank-1", correct: true, correctAnswer: "dominant" }, { id: "blank-2", correct: false, correctAnswer: "tonic" }] } } }) : response({ result: multi }), baseUrl: "https://app.example.test/", timeoutMs: 1_000 });
  const loaded = await gateway.loadReview("2026-08-19");
  assertEquals(loaded.ok, true);
  if (!loaded.ok) return;
  assertEquals(loaded.value.questions[0].blanks?.length, 2);
  assertEquals(JSON.stringify(loaded.value).includes("acceptedAnswers"), false);
  const answer = await gateway.answerReview("review:fill", "q-fill", [], "one", null, [{ id: "blank-1", text: "dominant" }, { id: "blank-2", text: "subdominant" }]);
  assertEquals(answer.ok, true);
  if (answer.ok) assertEquals(answer.value.score, 0.5);
});

Deno.test("learner gateway sends bounded completion, answer, preference, and deletion commands", async () => {
  /** @type {string[]} */ const methods = [];
  /** @type {unknown[]} */ const bodies = [];
  const gateway = new LearningBatchGatewayClient({
    fetch: async (_input, init) => {
      methods.push(init?.method ?? "GET");
      bodies.push(init?.body === undefined || init.body === null ? null : JSON.parse(String(init.body)));
      const body = init?.body === undefined || init.body === null ? null : JSON.parse(String(init.body));
      return response({ ownerId: "owner-a", result: body !== null && Object.hasOwn(body, "questionId") ? { completed: true, correct: true, score: 1, nextDueAt: "2026-08-20T00:00:00.000Z", feedback: { explanation: "Source-backed explanation.", correctAnswer: "A", components: [{ id: "choice-1", correct: true, correctAnswer: "A" }] } } : { ok: true, completed: true, correct: true } });
    },
    baseUrl: "https://app.example.test/",
    timeoutMs: 1_000,
  });
  assertEquals((await gateway.completeFeed("feed:a", "id-feed")).ok, true);
  assertEquals((await gateway.answerReview("review:a", "q1", ["choice-1"], "id-answer")).ok, true);
  assertEquals(Object.hasOwn(/** @type {Record<string,unknown>} */ (bodies[1]), "confidence"), false);
  assertEquals(bodies.length, 2);
  assertEquals((await gateway.setPreference("k1", "more", "id-more")).ok, true);
  assertEquals((await gateway.removeKnowledge("k1", "id-remove")).ok, true);
  assertEquals(methods.every((method) => method === "POST"), true);
  assertEquals(bodies.every((body) => typeof body === "object" && body !== null && !Object.hasOwn(/** @type {Record<string, unknown>} */ (body), "ownerId")), true);
});

Deno.test("learner gateway surfaces server locks instead of treating them as success", async () => {
  const gateway = new LearningBatchGatewayClient({ fetch: async () => response({ error: "ReviewRefreshLocked" }, 409), baseUrl: "https://app.example.test/", timeoutMs: 1_000 });
  const result = await gateway.refreshReview("id-refresh");
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "LearningBatchGatewayRejected");
});
