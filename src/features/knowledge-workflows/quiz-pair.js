// @ts-check

/** @typedef {{ readonly key: string, readonly text: string }} ChoiceOption */
/** @typedef {{ readonly id: string, readonly canonicalAnswer: string, readonly acceptedAnswers: readonly string[] }} CanonicalBlank */
/** @typedef {{ readonly multipleChoice: { readonly id: string, readonly kind: "single-choice" | "multiple-choice", readonly prompt: string, readonly options: readonly ChoiceOption[], readonly correctOptionKeys: readonly string[], readonly canonicalAnswers: readonly string[], readonly explanation: string }, readonly fillBlank: { readonly id: string, readonly kind: "fill-blank", readonly prompt: string, readonly blanks: readonly CanonicalBlank[], readonly canonicalAnswers: readonly string[], readonly explanation: string }, readonly canonicalAnswers: readonly string[], readonly citedEvidenceUrls: readonly string[] }} QuizPair */

const freeze = Object.freeze;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value @returns {value is readonly string[]} */
function textList(value) { return Array.isArray(value) && value.length > 0 && value.every(text); }
/** @param {unknown} value @param {readonly string[]} keys @returns {value is Record<string, unknown>} */
function exactRecord(value, keys) { return record(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)); }
/** @param {string} value @returns {string} */
function normalize(value) { return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/gu, " "); }

/**
 * Strict provider output contract. The provider cannot choose stable IDs;
 * callers derive them from the persisted source/knowledge revision.
 * @param {unknown} value
 * @returns {value is { readonly knowledgeId: string, readonly knowledgeRevision: number, readonly canonicalAnswers: readonly string[], readonly citedEvidenceUrls: readonly string[], readonly multipleChoice: { readonly prompt: string, readonly options: readonly ChoiceOption[], readonly correctOptionKeys: readonly string[], readonly correctOptionAnswers: readonly {readonly key:string,readonly canonicalAnswer:string}[], readonly explanation: string }, readonly fillBlank: { readonly prompt: string, readonly blanks: readonly CanonicalBlank[], readonly explanation: string } }}
 */
export function validateQuizPairDraft(value) {
  if (!exactRecord(value, ["knowledgeId", "knowledgeRevision", "canonicalAnswers", "citedEvidenceUrls", "multipleChoice", "fillBlank"]) || !text(value.knowledgeId) || typeof value.knowledgeRevision !== "number" || !Number.isSafeInteger(value.knowledgeRevision) || value.knowledgeRevision < 1 || !textList(value.canonicalAnswers) || value.canonicalAnswers.length > 4 || !textList(value.citedEvidenceUrls)) return false;
  const canonicalAnswers = /** @type {readonly string[]} */ (value.canonicalAnswers);
  if (new Set(canonicalAnswers.map(normalize)).size !== canonicalAnswers.length) return false;
  if (canonicalAnswers.some((answer) => !text(answer) || answer.length > 300)) return false;
  if (!exactRecord(value.multipleChoice, ["prompt", "options", "correctOptionKeys", "correctOptionAnswers", "explanation"]) || !text(value.multipleChoice.prompt) || value.multipleChoice.prompt.length > 1_000 || !text(value.multipleChoice.explanation) || value.multipleChoice.explanation.length > 4_000 || !Array.isArray(value.multipleChoice.options) || value.multipleChoice.options.length < 2 || value.multipleChoice.options.length > 8 || !Array.isArray(value.multipleChoice.correctOptionKeys) || value.multipleChoice.correctOptionKeys.length < 1 || !value.multipleChoice.correctOptionKeys.every(text) || !Array.isArray(value.multipleChoice.correctOptionAnswers) || value.multipleChoice.correctOptionAnswers.length !== canonicalAnswers.length || !value.multipleChoice.correctOptionAnswers.every((entry) => exactRecord(entry, ["key", "canonicalAnswer"]) && text(entry.key) && text(entry.canonicalAnswer))) return false;
  const options = value.multipleChoice.options;
  if (!options.every((option) => exactRecord(option, ["key", "text"]) && text(option.key) && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(option.key) && text(option.text) && option.text.length <= 500)) return false;
  const optionKeys = options.map((option) => /** @type {string} */ (option.key));
  const optionTexts = options.map((option) => /** @type {string} */ (option.text));
  const correctKeys = /** @type {readonly string[]} */ (value.multipleChoice.correctOptionKeys);
  const correctOptionAnswers = /** @type {readonly {readonly key:string,readonly canonicalAnswer:string}[]} */ (value.multipleChoice.correctOptionAnswers);
  if (new Set(optionKeys).size !== optionKeys.length || new Set(optionTexts.map(normalize)).size !== optionTexts.length || new Set(correctKeys).size !== correctKeys.length || correctKeys.some((key) => !optionKeys.includes(key)) || correctKeys.length !== canonicalAnswers.length || correctKeys.some((key, index) => key !== correctOptionAnswers[index]?.key) || new Set(correctOptionAnswers.map((entry) => normalize(entry.canonicalAnswer))).size !== canonicalAnswers.length || canonicalAnswers.some((answer) => !correctOptionAnswers.some((entry) => normalize(entry.canonicalAnswer) === normalize(answer)))) return false;
  if (canonicalAnswers.some((answer) => optionKeys.includes(answer))) return false;
  if (!exactRecord(value.fillBlank, ["prompt", "blanks", "explanation"]) || !text(value.fillBlank.prompt) || value.fillBlank.prompt.length > 1_000 || !text(value.fillBlank.explanation) || value.fillBlank.explanation.length > 4_000 || !Array.isArray(value.fillBlank.blanks) || value.fillBlank.blanks.length !== canonicalAnswers.length) return false;
  const blanks = value.fillBlank.blanks;
  if (!blanks.every((blank, index) => exactRecord(blank, ["id", "canonicalAnswer", "acceptedAnswers"]) && blank.id === `blank-${index + 1}` && text(blank.canonicalAnswer) && normalize(blank.canonicalAnswer) === normalize(canonicalAnswers[index]) && textList(blank.acceptedAnswers) && blank.acceptedAnswers.length <= 12 && normalize(blank.acceptedAnswers[0]) === normalize(canonicalAnswers[index]) && new Set(blank.acceptedAnswers.map(normalize)).size === blank.acceptedAnswers.length)) return false;
  return (value.fillBlank.prompt.match(/(?<!_)____(?!_)/gu) ?? []).length === blanks.length && !/(?<!_)_{1,3}(?!_)/u.test(value.fillBlank.prompt);
}

/** @param {unknown} value @returns {value is { readonly knowledgeId:string, readonly knowledgeRevision:number, readonly canonicalAnswers:readonly string[], readonly citedEvidenceUrls:readonly string[], readonly multipleChoice:{readonly prompt:string,readonly options:readonly ChoiceOption[],readonly correctOptionKeys:readonly string[],readonly correctOptionAnswers:readonly {readonly key:string,readonly canonicalAnswer:string}[],readonly explanation:string},readonly fillBlank:{readonly prompt:string,readonly blanks:readonly CanonicalBlank[],readonly explanation:string} }} */
export function isQuizPairDraft(value) { return validateQuizPairDraft(value); }

/** @param {unknown} value */
export function quizPairSchema(value) {
  if (value !== true) throw new TypeError("Quiz pair schema selector is invalid.");
  const string = { type: "string", minLength: 1 };
  const stringListSchema = { type: "array", minItems: 1, items: string };
  return Object.freeze({ name: "paired_quiz_v1", schema: Object.freeze({ type: "object", additionalProperties: false, properties: {
    knowledgeId: string, knowledgeRevision: { type: "integer", minimum: 1 }, canonicalAnswers: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", minLength: 1, maxLength: 300 } }, citedEvidenceUrls: stringListSchema,
    multipleChoice: { type: "object", additionalProperties: false, properties: { prompt: string, options: { type: "array", minItems: 2, maxItems: 8, items: { type: "object", additionalProperties: false, properties: { key: string, text: string }, required: ["key", "text"] } }, correctOptionKeys: stringListSchema, correctOptionAnswers: { type: "array", minItems: 1, maxItems: 4, items: { type: "object", additionalProperties: false, properties: { key: string, canonicalAnswer: string }, required: ["key", "canonicalAnswer"] } }, explanation: string }, required: ["prompt", "options", "correctOptionKeys", "correctOptionAnswers", "explanation"] },
    fillBlank: { type: "object", additionalProperties: false, properties: { prompt: string, blanks: { type: "array", minItems: 1, maxItems: 4, items: { type: "object", additionalProperties: false, properties: { id: string, canonicalAnswer: string, acceptedAnswers: { type: "array", minItems: 1, maxItems: 12, items: string } }, required: ["id", "canonicalAnswer", "acceptedAnswers"] } }, explanation: string }, required: ["prompt", "blanks", "explanation"] },
  }, required: ["knowledgeId", "knowledgeRevision", "canonicalAnswers", "citedEvidenceUrls", "multipleChoice", "fillBlank"] }) });
}

/**
 * Derive repeatable IDs from immutable ownership/version identity.
 * @param {{ readonly sourceId: string, readonly knowledgeId: string, readonly revision: number }} scope
 * @returns {string}
 */
export function quizPairStableId(scope) {
  if (!record(scope) || !text(scope.sourceId) || !text(scope.knowledgeId) || !Number.isSafeInteger(scope.revision) || scope.revision < 1) throw new TypeError("Quiz pair identity is invalid.");
  return `quiz:${encodeURIComponent(scope.sourceId)}:${encodeURIComponent(scope.knowledgeId)}:r${scope.revision}`;
}

/** @param {unknown} value @param {string} stableId @returns {QuizPair} */
export function assembleQuizPair(value, stableId) {
  if (!validateQuizPairDraft(value) || !text(stableId) || stableId.endsWith(":")) throw new TypeError("Quiz pair draft is invalid.");
  const draft = value;
  const canonicalAnswers = freeze([...draft.canonicalAnswers]);
  const options = freeze(draft.multipleChoice.options.map((option) => freeze({ key: option.key, text: option.text })));
  const correctOptionKeys = freeze([...draft.multipleChoice.correctOptionKeys]);
  const blanks = freeze(draft.fillBlank.blanks.map((blank) => freeze({ id: blank.id, canonicalAnswer: blank.canonicalAnswer, acceptedAnswers: freeze([...blank.acceptedAnswers]) })));
  return freeze({
    canonicalAnswers,
    multipleChoice: freeze({ id: `${stableId}:mcq`, kind: correctOptionKeys.length === 1 ? "single-choice" : "multiple-choice", prompt: draft.multipleChoice.prompt, options, correctOptionKeys, canonicalAnswers, explanation: draft.multipleChoice.explanation }),
    fillBlank: freeze({ id: `${stableId}:fill`, kind: "fill-blank", prompt: draft.fillBlank.prompt, blanks, canonicalAnswers, explanation: draft.fillBlank.explanation }),
    citedEvidenceUrls: freeze([...draft.citedEvidenceUrls]),
  });
}

/** @param {unknown} value @returns {value is QuizPair} */
export function validateAssembledQuizPair(value) {
  if (!exactRecord(value, ["multipleChoice", "fillBlank", "canonicalAnswers", "citedEvidenceUrls"]) || !textList(value.canonicalAnswers) || !textList(value.citedEvidenceUrls) || value.canonicalAnswers.length > 4 || new Set(value.canonicalAnswers.map(normalize)).size !== value.canonicalAnswers.length) return false;
  const answers = /** @type {readonly string[]} */ (value.canonicalAnswers);
  const mcq = value.multipleChoice;
  const fill = value.fillBlank;
  if (!record(mcq) || !exactRecord(mcq, ["id", "kind", "prompt", "options", "correctOptionKeys", "canonicalAnswers", "explanation"]) || !text(mcq.id) || (mcq.kind !== "single-choice" && mcq.kind !== "multiple-choice") || !text(mcq.prompt) || !text(mcq.explanation) || !Array.isArray(mcq.options) || mcq.options.length < 2 || !mcq.options.every((option) => exactRecord(option, ["key", "text"]) && text(option.key) && text(option.text)) || !textList(mcq.correctOptionKeys) || mcq.correctOptionKeys.length !== answers.length || !textList(mcq.canonicalAnswers) || mcq.canonicalAnswers.length !== answers.length || answers.some((answer) => !(/** @type {readonly string[]} */ (mcq.canonicalAnswers)).some((candidate) => normalize(candidate) === normalize(answer)))) return false;
  const options = /** @type {readonly ChoiceOption[]} */ (mcq.options);
  const correctKeys = /** @type {readonly string[]} */ (mcq.correctOptionKeys);
  if (new Set(options.map((option) => option.key)).size !== options.length || new Set(correctKeys).size !== correctKeys.length || correctKeys.some((key) => !options.some((option) => option.key === key)) || (mcq.kind === "single-choice") !== (correctKeys.length === 1)) return false;
  if (!record(fill) || !exactRecord(fill, ["id", "kind", "prompt", "blanks", "canonicalAnswers", "explanation"]) || !text(fill.id) || fill.kind !== "fill-blank" || !text(fill.prompt) || !Array.isArray(fill.blanks) || fill.blanks.length !== answers.length || !textList(fill.canonicalAnswers) || fill.canonicalAnswers.length !== answers.length || answers.some((answer, index) => normalize(/** @type {readonly string[]} */ (fill.canonicalAnswers)[index]) !== normalize(answer)) || !text(fill.explanation)) return false;
  const blanks = fill.blanks;
  if (!blanks.every((blank, index) => exactRecord(blank, ["id", "canonicalAnswer", "acceptedAnswers"]) && blank.id === `blank-${index + 1}` && text(blank.canonicalAnswer) && normalize(blank.canonicalAnswer) === normalize(answers[index]) && textList(blank.acceptedAnswers) && normalize(blank.acceptedAnswers[0]) === normalize(answers[index]))) return false;
  return (fill.prompt.match(/(?<!_)____(?!_)/gu) ?? []).length === blanks.length;
}
