// @ts-check

import { assembleQuizPair, limitChoiceOptions, normalizeAssembledQuizPairLimits, normalizeQuizPairDraftLimits, quizPairDraftValidationIssues, quizPairSchema, quizPairStableId, validateAssembledQuizPair, validateQuizPairDraft } from "../src/features/knowledge-workflows/quiz-pair.js";

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

Deno.test("quiz pairs cap correct options and blanks at three, and total MCQ options at five", () => {
  const multi = draft();
  multi.canonicalAnswers = ["tonic", "dominant", "mediant"];
  multi.multipleChoice.options = ["tonic", "dominant", "mediant", "subtonic", "leading tone"].map((answer, index) => ({ key: `option-${index + 1}`, text: answer }));
  multi.multipleChoice.correctOptionKeys = ["option-1", "option-2", "option-3"];
  multi.multipleChoice.correctOptionAnswers = multi.canonicalAnswers.map((canonicalAnswer, index) => ({ key: `option-${index + 1}`, canonicalAnswer }));
  multi.fillBlank.prompt = "The first, fifth, and third scale degrees are ____, ____, and ____.";
  multi.fillBlank.blanks = multi.canonicalAnswers.map((canonicalAnswer, index) => ({ id: `blank-${index + 1}`, canonicalAnswer, acceptedAnswers: [canonicalAnswer] }));
  assertEquals(validateQuizPairDraft(multi), true);
  const pair = assembleQuizPair(multi, "quiz:source:knowledge-a:r1");
  assertEquals(validateAssembledQuizPair(pair), true);
  const four = structuredClone(multi);
  four.canonicalAnswers.push("subtonic");
  four.multipleChoice.correctOptionKeys.push("option-4");
  four.multipleChoice.correctOptionAnswers.push({ key: "option-4", canonicalAnswer: "subtonic" });
  four.fillBlank.blanks.push({ id: "blank-4", canonicalAnswer: "subtonic", acceptedAnswers: ["subtonic"] });
  four.fillBlank.prompt += " The seventh is ____.";
  assertEquals(validateQuizPairDraft(four), false);
  assertEquals(quizPairDraftValidationIssues(four).some(issue => issue.includes("one to three")), true);
  const legacyFour = { ...pair, canonicalAnswers: four.canonicalAnswers, multipleChoice: { ...pair.multipleChoice, canonicalAnswers: four.canonicalAnswers, correctOptionKeys: four.multipleChoice.correctOptionKeys }, fillBlank: { ...pair.fillBlank, canonicalAnswers: four.canonicalAnswers, prompt: four.fillBlank.prompt, blanks: four.fillBlank.blanks } };
  assertEquals(validateAssembledQuizPair(legacyFour), false);
  const untouched = JSON.stringify(four);
  const limited = normalizeQuizPairDraftLimits(four, () => 0);
  assertEquals(validateQuizPairDraft(limited), true);
  if (!validateQuizPairDraft(limited)) throw new Error("Expected limited quiz pair");
  assertEquals(limited.fillBlank.prompt.includes("The seventh is subtonic."), true);
  assertEquals(limited.fillBlank.blanks.length, 3);
  assertEquals(limited.multipleChoice.correctOptionKeys.includes("option-4"), false);
  assertEquals(limited.multipleChoice.options.some(option => option.key === "option-4"), false);
  assertEquals(JSON.stringify(four), untouched);
  const reorderedMappings = structuredClone(four);
  reorderedMappings.multipleChoice.correctOptionKeys.reverse();
  reorderedMappings.multipleChoice.correctOptionAnswers.reverse();
  const aligned = normalizeQuizPairDraftLimits(reorderedMappings, () => 0);
  if (!validateQuizPairDraft(aligned)) throw new Error("Expected aligned answer mappings");
  assertEquals(aligned.multipleChoice.correctOptionKeys.join(","), "option-1,option-2,option-3");
  assertEquals(aligned.multipleChoice.options.some(option => option.key === "option-4"), false);
  const limitedPersisted = normalizeAssembledQuizPairLimits(legacyFour, () => 0);
  assertEquals(validateAssembledQuizPair(limitedPersisted), true);
  if (!validateAssembledQuizPair(limitedPersisted)) throw new Error("Expected limited persisted pair");
  assertEquals(limitedPersisted.fillBlank.id, pair.fillBlank.id);
  assertEquals(limitedPersisted.multipleChoice.id, pair.multipleChoice.id);
  for (const correctCount of [1, 3]) {
    const tooManyOptions = correctCount === 1 ? draft() : structuredClone(multi);
    while (tooManyOptions.multipleChoice.options.length < 5) {
      const id = tooManyOptions.multipleChoice.options.length + 1;
      tooManyOptions.multipleChoice.options.push({ key: `extra-${id}`, text: `Other possibility ${id}` });
    }
    assertEquals(validateQuizPairDraft(tooManyOptions), true);
    tooManyOptions.multipleChoice.options.push({ key: "option-6", text: "supertonic" });
    assertEquals(validateQuizPairDraft(tooManyOptions), false);
  }
  assertEquals(validateAssembledQuizPair({ ...pair, multipleChoice: { ...pair.multipleChoice, options: [...pair.multipleChoice.options, { key: "option-6", text: "supertonic" }] } }), false);
  const schema = quizPairSchema(true).schema.properties;
  assertEquals(schema.canonicalAnswers.maxItems, 3);
  assertEquals(schema.multipleChoice.properties.correctOptionKeys.maxItems, 3);
  assertEquals(schema.multipleChoice.properties.correctOptionAnswers.maxItems, 3);
  assertEquals(schema.fillBlank.properties.blanks.maxItems, 3);
  assertEquals(schema.multipleChoice.properties.options.maxItems, 5);
});

Deno.test("MCQ fallback randomly removes only incorrect options and preserves remaining order", () => {
  const options = ["wrong-a", "right-a", "wrong-b", "right-b", "wrong-c", "right-c", "wrong-d"].map(key => ({ key }));
  const correct = ["right-a", "right-b", "right-c"];
  const first = limitChoiceOptions(options, correct, () => 0);
  const last = limitChoiceOptions(options, correct, () => 0.999);
  assertEquals(first.length, 5);
  assertEquals(last.length, 5);
  assertEquals(first.some(option => option.key === "wrong-a"), false);
  assertEquals(last.some(option => option.key === "wrong-d"), false);
  assertEquals(first.map(option => option.key).join(","), "right-a,right-b,wrong-c,right-c,wrong-d");
  for (const key of correct) {
    assertEquals(first.some(option => option.key === key), true);
    assertEquals(last.some(option => option.key === key), true);
  }
  assertEquals(options.length, 7);
  const malformed = { ...draft(), unexpected: true };
  assertEquals(normalizeQuizPairDraftLimits(malformed), malformed);
});
