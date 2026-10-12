// @ts-check

import { assembleQuizPair, quizPairSchema, quizPairStableId, validateAssembledQuizPair, validateQuizPairDraft } from "../src/features/knowledge-workflows/quiz-pair.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

function draft() {
  return {
    knowledgeId: "knowledge-a",
    knowledgeRevision: 1,
    canonicalAnswers: ["tonic"],
    citedEvidenceUrls: ["https://example.test/source#cadence"],
    multipleChoice: {
      prompt: "Which pitch is the tonal center?",
      options: [{ key: "choice-a", text: "The tonic" }, { key: "choice-b", text: "The dominant" }],
      correctOptionKeys: ["choice-a"],
      correctOptionAnswers: [{ key: "choice-a", canonicalAnswer: "tonic" }],
      explanation: "The tonic is the tonal center.",
    },
    fillBlank: {
      prompt: "The tonal center is the ____. ",
      blanks: [{ id: "blank-1", canonicalAnswer: "tonic", acceptedAnswers: ["tonic", "tonic note"] }],
      explanation: "The tonic is the tonal center.",
    },
  };
}

Deno.test("quiz pair validates exact structured fields and stable variant assembly", () => {
  const source = draft();
  assertEquals(validateQuizPairDraft(source), true);
  const mathematicalIdentifier = { ...source, fillBlank: { ...source.fillBlank, prompt: "In x_t, the tonal center is the ____." } };
  assertEquals(validateQuizPairDraft(mathematicalIdentifier), true);
  const stableId = quizPairStableId({ sourceId: "source-a", knowledgeId: "knowledge-a", revision: 1 });
  const pair = assembleQuizPair(source, stableId);
  assertEquals(pair.multipleChoice.id, "quiz:source-a:knowledge-a:r1:mcq");
  assertEquals(pair.fillBlank.id, "quiz:source-a:knowledge-a:r1:fill");
  assertEquals(pair.multipleChoice.canonicalAnswers[0], "tonic");
  assertEquals(pair.fillBlank.blanks[0].canonicalAnswer, "tonic");
});

Deno.test("quiz pair rejects unknown keys, duplicate option keys, and answer mismatches", () => {
  const unknown = { ...draft(), key: "extra" };
  const duplicate = draft();
  duplicate.multipleChoice.options[1].key = "choice-a";
  const mismatched = draft();
  mismatched.fillBlank.blanks[0].canonicalAnswer = "dominant";
  for (const value of [unknown, duplicate, mismatched]) assertEquals(validateQuizPairDraft(value), false);
});

Deno.test("quiz pair rejects answer identifiers used in place of canonical answer text", () => {
  const value = draft();
  value.canonicalAnswers[0] = "choice-a";
  assertEquals(validateQuizPairDraft(value), false);
});

Deno.test("quiz pair enforces canonical correspondence, strict blanks, and multi-select cardinality", () => {
  const multi = draft();
  multi.canonicalAnswers.push("dominant");
  multi.multipleChoice.options.push({ key: "choice-c", text: "Leading tone" });
  multi.multipleChoice.correctOptionKeys.push("choice-b");
  multi.multipleChoice.correctOptionAnswers.push({ key: "choice-b", canonicalAnswer: "dominant" });
  multi.fillBlank.prompt = "The tonic and fifth scale degree are ____ and ____ .";
  multi.fillBlank.blanks.push({ id: "blank-2", canonicalAnswer: "dominant", acceptedAnswers: ["dominant"] });
  assertEquals(validateQuizPairDraft(multi), true);
  assertEquals(quizPairSchema(true).schema !== undefined, true);
  const malformedBlank = { ...multi, fillBlank: { ...multi.fillBlank, prompt: "The tonic and fifth scale degree are ____ and _____." } };
  assertEquals(validateQuizPairDraft(malformedBlank), false);
  const mismatch = draft();
  mismatch.multipleChoice.correctOptionAnswers[0].canonicalAnswer = "dominant";
  assertEquals(validateQuizPairDraft(mismatch), false);
  const wrongCardinality = draft();
  wrongCardinality.multipleChoice.correctOptionKeys.push("choice-b");
  assertEquals(validateQuizPairDraft(wrongCardinality), false);

  const pair = assembleQuizPair(multi, "quiz:source:knowledge-a:r1");
  assertEquals(validateAssembledQuizPair(pair), true);
  const unrelated = { ...pair, fillBlank: { ...pair.fillBlank, canonicalAnswers: ["unrelated", "dominant"] } };
  assertEquals(validateAssembledQuizPair(unrelated), false);
  const reordered = { ...pair, fillBlank: { ...pair.fillBlank, canonicalAnswers: ["dominant", "tonic"] } };
  assertEquals(validateAssembledQuizPair(reordered), false);
});
