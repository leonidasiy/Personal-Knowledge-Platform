// @ts-check

import { LocalQuestionGrader } from "../src/features/questions/grading.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

const grader = new LocalQuestionGrader();
const questionMetadata = Object.freeze({
  contentId: "content-1",
  contentVersion: 1,
  knowledgeUnitIds: /** @type {const} */ (["knowledge-1"]),
  sourceAnchorIds: /** @type {const} */ (["anchor-1"]),
  generatorVersion: "test-generator-v1",
  version: 1,
  scorerVersion: "test-scorer-v1",
  provenance: "test-fixture",
});
const choices = Object.freeze([
  Object.freeze({ id: "pulse", label: "Pulse" }),
  Object.freeze({ id: "accent", label: "Accent position" }),
  Object.freeze({ id: "pitch", label: "Pitch" }),
]);

Deno.test("single-choice requires the exact valid answer", () => {
  const question = {
    ...questionMetadata,
    id: "single",
    kind: /** @type {const} */ ("single-choice"),
    prompt: "What remains stable?",
    choices,
    correctChoiceIds: /** @type {const} */ (["pulse"]),
    explanation: "The pulse remains stable.",
  };
  const correct = grader.grade(question, {
    kind: "choice",
    selectedChoiceIds: ["pulse"],
  });
  assertEquals(correct.ok && correct.value.status, "correct");
  const unknown = grader.grade(question, {
    kind: "choice",
    selectedChoiceIds: ["missing"],
  });
  assertEquals(!unknown.ok && unknown.error.kind, "ChoiceUnknown");
});

Deno.test("multiple-choice compares sets without depending on answer order", () => {
  const result = grader.grade({
    ...questionMetadata,
    id: "multiple",
    kind: "multiple-choice",
    prompt: "Select both rhythmic properties.",
    choices,
    correctChoiceIds: ["pulse", "accent"],
    explanation: "Both describe rhythm.",
  }, {
    kind: "choice",
    selectedChoiceIds: ["accent", "pulse"],
  });
  assertEquals(result.ok && result.value.status, "correct");
});

Deno.test("fill-in-the-blank normalizes case, punctuation, and whitespace", () => {
  const result = grader.grade({
    ...questionMetadata,
    id: "blank",
    kind: "fill-blank",
    blankId: "blank-1",
    prompt: "The stable grid is the ___.",
    acceptedAnswers: ["underlying pulse", "pulse"],
    explanation: "The pulse is stable.",
  }, {
    kind: "fill",
    blankId: "blank-1",
    text: "  Underlying PULSE! ",
  });
  assertEquals(result.ok && result.value.status, "correct");
});

Deno.test("open responses pass only with complete concept coverage", () => {
  const result = grader.grade({
    ...questionMetadata,
    id: "open",
    kind: "free-response",
    prompt: "Explain rhythmic displacement.",
    expectedConcepts: ["underlying pulse", "accent pattern"],
    minimumWords: 4,
    explanation: "The accent shifts over a stable pulse.",
  }, {
    kind: "text",
    text: "The accent pattern shifts against the underlying pulse.",
  });
  assertEquals(result.ok && result.value.status, "correct");
});

Deno.test("plausible partial open responses require review", () => {
  const child = {
    ...questionMetadata,
    id: "case-response",
    kind: /** @type {const} */ ("free-response"),
    prompt: "Analyze this displaced groove.",
    expectedConcepts: ["steady pulse", "shifted accent"],
    minimumWords: 5,
    explanation: "Compare accents with the pulse.",
  };
  const caseGrader = new LocalQuestionGrader({
    resolveQuestion: (id) => id === child.id ? child : null,
  });
  const result = caseGrader.grade({
    ...questionMetadata,
    id: "case",
    kind: "case-study",
    stimulus: "A groove shifts against a metronome.",
    childQuestionIds: ["case-response"],
    prompt: "Analyze this displaced groove.",
    explanation: "Compare accents with the pulse.",
  }, {
    kind: "case-study",
    childResponses: [{
      questionId: "case-response",
      response: {
        kind: "text",
        text: "The steady pulse continues while the phrase changes position.",
      },
    }],
  });
  assertEquals(result.ok && result.value.status, "review-required");
});

Deno.test("complete concept phrases do not bypass the minimum response length", () => {
  const result = grader.grade({
    ...questionMetadata,
    id: "open-short",
    kind: "free-response",
    prompt: "Explain tonic stability.",
    expectedConcepts: ["tonal center", "resolution"],
    minimumWords: 5,
    explanation: "Connect tonic to stability and resolution.",
  }, { kind: "text", text: "tonal center resolution" });
  assertEquals(result.ok && result.value.status, "incorrect");
});

Deno.test("clearly insufficient open responses are incorrect", () => {
  const child = {
    ...questionMetadata,
    id: "case-response",
    kind: /** @type {const} */ ("free-response"),
    prompt: "Analyze this displaced groove.",
    expectedConcepts: ["steady pulse", "shifted accent"],
    minimumWords: 5,
    explanation: "Compare accents with the pulse.",
  };
  const caseGrader = new LocalQuestionGrader({
    resolveQuestion: (id) => id === child.id ? child : null,
  });
  const result = caseGrader.grade({
    ...questionMetadata,
    id: "case",
    kind: "case-study",
    stimulus: "A groove shifts against a metronome.",
    childQuestionIds: ["case-response"],
    prompt: "Analyze this displaced groove.",
    explanation: "Compare accents with the pulse.",
  }, {
    kind: "case-study",
    childResponses: [{
      questionId: "case-response",
      response: { kind: "text", text: "Not sure" },
    }],
  });
  assertEquals(result.ok && result.value.status, "incorrect");
});

Deno.test("response-kind mismatch and empty responses are named failures", () => {
  const mismatch = grader.grade({
    ...questionMetadata,
    id: "blank",
    kind: "fill-blank",
    blankId: "blank-1",
    prompt: "The stable grid is the ___.",
    acceptedAnswers: ["pulse"],
    explanation: "The pulse is stable.",
  }, { kind: "choice", selectedChoiceIds: ["pulse"] });
  assertEquals(!mismatch.ok && mismatch.error.kind, "ResponseKindMismatch");

  const empty = grader.grade({
    ...questionMetadata,
    id: "blank",
    kind: "fill-blank",
    blankId: "blank-1",
    prompt: "The stable grid is the ___.",
    acceptedAnswers: ["pulse"],
    explanation: "The pulse is stable.",
  }, { kind: "fill", blankId: "blank-1", text: "   " });
  assertEquals(!empty.ok && empty.error.kind, "ResponseInvalid");
});

Deno.test("unsupported and malformed question documents fail explicitly", () => {
  const unsupported = grader.grade(
    { ...questionMetadata, id: "x", kind: "ranking" },
    { kind: "text", text: "answer" },
  );
  assertEquals(
    !unsupported.ok && unsupported.error.kind,
    "QuestionKindUnsupported",
  );
  const malformed = grader.grade({}, {});
  assertEquals(
    !malformed.ok && malformed.error.kind,
    "QuestionKindUnsupported",
  );
});

Deno.test("malformed case-study child responses fail explicitly", () => {
  const result = grader.grade({
    ...questionMetadata,
    id: "case",
    kind: "case-study",
    stimulus: "A short musical example.",
    childQuestionIds: ["child"],
    prompt: "Analyze the example.",
    explanation: "Connect the example to the learned concept.",
  }, {
    kind: "case-study",
    childResponses: [null],
  });
  assertEquals(!result.ok && result.error.kind, "ResponseInvalid");
});
