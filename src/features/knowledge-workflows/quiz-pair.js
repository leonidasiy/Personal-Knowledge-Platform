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
  return (value.fillBlank.prompt.match(/(?<!_)____(?!_)/gu) ?? []).length === blanks.length;
}

/** @param {unknown} value @returns {value is { readonly knowledgeId:string, readonly knowledgeRevision:number, readonly canonicalAnswers:readonly string[], readonly citedEvidenceUrls:readonly string[], readonly multipleChoice:{readonly prompt:string,readonly options:readonly ChoiceOption[],readonly correctOptionKeys:readonly string[],readonly correctOptionAnswers:readonly {readonly key:string,readonly canonicalAnswer:string}[],readonly explanation:string},readonly fillBlank:{readonly prompt:string,readonly blanks:readonly CanonicalBlank[],readonly explanation:string} }} */
export function isQuizPairDraft(value) { return validateQuizPairDraft(value); }

/** Canonicalize redundant aliases only after the complete resulting draft passes the unchanged strict validator.
 * Keep the first spelling and order, including each blank's first canonical spelling, and distinct synonyms.
 * Unknown fields, counts, identities, answer mappings and prompt blanks remain strict; failed candidates stay raw.
 * The received provider object is never mutated or replaced in historical stage storage.
 * @param {unknown} value @returns {unknown}
 */
export function normalizeQuizPairDraftAliases(value) {
  if (validateQuizPairDraft(value)) return value;
  if (!record(value) || !record(value.fillBlank) || !Array.isArray(value.fillBlank.blanks) || !value.fillBlank.blanks.every(blank => record(blank) && textList(blank.acceptedAnswers) && blank.acceptedAnswers.length <= 12)) return value;
  const candidate = { ...value, fillBlank: { ...value.fillBlank, blanks: value.fillBlank.blanks.map(blank => {
    const seen = new Set();
    const acceptedAnswers = blank.acceptedAnswers.filter((/** @type {string} */ answer) => { const key = normalize(answer); if (seen.has(key)) return false; seen.add(key); return true; });
    return { ...blank, acceptedAnswers };
  }) } };
  return validateQuizPairDraft(candidate) ? candidate : value;
}

/** Explain all applicable strict paired-draft faults for the existing bounded regeneration.
 * This never changes acceptance or repairs provider data.
 * @param {unknown} value @returns {readonly string[]}
 */
export function quizPairDraftValidationIssues(value) {
  if (validateQuizPairDraft(value)) return freeze([]);
  const issues = [];
  if (!exactRecord(value, ["knowledgeId", "knowledgeRevision", "canonicalAnswers", "citedEvidenceUrls", "multipleChoice", "fillBlank"])) return freeze(["draft: return exactly the required paired-quiz fields."]);
  if (!text(value.knowledgeId)) issues.push("knowledgeId: use a nonempty knowledge ID.");
  if (typeof value.knowledgeRevision !== "number" || !Number.isSafeInteger(value.knowledgeRevision) || value.knowledgeRevision < 1) issues.push("knowledgeRevision: use a positive integer revision.");
  if (!textList(value.citedEvidenceUrls)) issues.push("citedEvidenceUrls: include nonempty cited source URLs.");
  const answers = textList(value.canonicalAnswers) ? value.canonicalAnswers : null;
  if (answers === null) issues.push("canonicalAnswers: include nonempty answer text.");
  else {
    if (answers.length > 4 || answers.some(answer => answer.length > 300)) issues.push("canonicalAnswers: use one to four answers of at most 300 characters.");
    if (new Set(answers.map(normalize)).size !== answers.length) issues.push("canonicalAnswers: all answers must be distinct after NFKC, whitespace and case normalization.");
  }
  const mc = value.multipleChoice;
  if (!exactRecord(mc, ["prompt", "options", "correctOptionKeys", "correctOptionAnswers", "explanation"])) issues.push("multipleChoice: return exactly prompt, options, correctOptionKeys, correctOptionAnswers and explanation.");
  else {
    if (!text(mc.prompt) || mc.prompt.length > 1_000) issues.push("multipleChoice.prompt: use nonempty text of at most 1000 characters.");
    if (!text(mc.explanation) || mc.explanation.length > 4_000) issues.push("multipleChoice.explanation: use nonempty text of at most 4000 characters.");
    const options = Array.isArray(mc.options) && mc.options.every(option => exactRecord(option, ["key", "text"]) && text(option.key) && text(option.text)) ? mc.options : null;
    if (options === null) issues.push("multipleChoice.options: each option needs exactly a nonempty key and text.");
    else {
      if (options.length < 2 || options.length > 8 || options.some(option => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(option.key) || option.text.length > 500)) issues.push("multipleChoice.options: use two to eight valid option keys with text of at most 500 characters.");
      if (new Set(options.map(option => option.key)).size !== options.length) issues.push("multipleChoice.options: keys must be unique.");
      if (new Set(options.map(option => normalize(option.text))).size !== options.length) issues.push("multipleChoice.options: option texts must be unique after normalization.");
      if (answers?.some(answer => options.some(option => option.key === answer))) issues.push("canonicalAnswers: use answer text rather than option keys.");
    }
    const keys = textList(mc.correctOptionKeys) ? mc.correctOptionKeys : null;
    if (keys === null) issues.push("multipleChoice.correctOptionKeys: include nonempty correct option keys.");
    else if (new Set(keys).size !== keys.length || answers && keys.length !== answers.length || options && keys.some(key => !options.some(option => option.key === key))) issues.push("multipleChoice.correctOptionKeys: use one unique existing option key per canonical answer.");
    const mappings = Array.isArray(mc.correctOptionAnswers) && mc.correctOptionAnswers.every(entry => exactRecord(entry, ["key", "canonicalAnswer"]) && text(entry.key) && text(entry.canonicalAnswer)) ? mc.correctOptionAnswers : null;
    if (mappings === null) issues.push("multipleChoice.correctOptionAnswers: each entry needs exactly key and canonicalAnswer.");
    else {
      if (answers && (mappings.length !== answers.length || new Set(mappings.map(entry => normalize(entry.canonicalAnswer))).size !== answers.length || answers.some(answer => !mappings.some(entry => normalize(entry.canonicalAnswer) === normalize(answer))))) issues.push("multipleChoice.correctOptionAnswers: map each canonical answer exactly once, using the same answer text.");
      if (keys && keys.some((key, index) => key !== mappings[index]?.key)) issues.push("multipleChoice.correctOptionAnswers: keys must align with correctOptionKeys in corresponding order.");
    }
  }
  const fill = value.fillBlank;
  if (!exactRecord(fill, ["prompt", "blanks", "explanation"])) issues.push("fillBlank: return exactly prompt, blanks and explanation.");
  else {
    if (!text(fill.prompt) || fill.prompt.length > 1_000) issues.push("fillBlank.prompt: use nonempty text of at most 1000 characters.");
    if (!text(fill.explanation) || fill.explanation.length > 4_000) issues.push("fillBlank.explanation: use nonempty text of at most 4000 characters.");
    if (!Array.isArray(fill.blanks)) issues.push("fillBlank.blanks: include the ordered blank entries.");
    else {
      if (answers && fill.blanks.length !== answers.length) issues.push("fillBlank.blanks: include exactly one blank per canonical answer.");
      fill.blanks.forEach((blank, index) => {
        const field = `fillBlank.blanks[${index}]`;
        if (!exactRecord(blank, ["id", "canonicalAnswer", "acceptedAnswers"])) { issues.push(`${field}: return exactly id, canonicalAnswer and acceptedAnswers.`); return; }
        if (blank.id !== `blank-${index + 1}`) issues.push(`${field}.id: use sequential blank-${index + 1}.`);
        if (!text(blank.canonicalAnswer) || answers && index < answers.length && normalize(blank.canonicalAnswer) !== normalize(answers[index])) issues.push(`${field}.canonicalAnswer: use canonicalAnswers[${index}] without substituting a subset or combined phrase.`);
        if (!textList(blank.acceptedAnswers)) issues.push(`${field}.acceptedAnswers: include the canonical answer first; synonyms are optional.`);
        else {
          if (blank.acceptedAnswers.length > 12) issues.push(`${field}.acceptedAnswers: include at most 12 accepted answers.`);
          if (answers && index < answers.length && normalize(blank.acceptedAnswers[0]) !== normalize(answers[index])) issues.push(`${field}.acceptedAnswers[0]: use canonicalAnswers[${index}].`);
          const normalizedAliases = blank.acceptedAnswers.map(normalize);
          if (new Set(normalizedAliases).size !== normalizedAliases.length) {
            const duplicate = normalizedAliases.find((alias, aliasIndex) => normalizedAliases.indexOf(alias) < aliasIndex);
            issues.push(`${field}.acceptedAnswers: remove NFKC-equivalent, case or whitespace duplicate aliases. At least two entries normalize to ${JSON.stringify(duplicate)}; keep only one entry for each normalized value across this entire array. The canonical answer alone is sufficient.`);
          }
        }
      });
      if (typeof fill.prompt === "string" && (fill.prompt.match(/(?<!_)____(?!_)/gu) ?? []).length !== fill.blanks.length) issues.push("fillBlank.prompt: include exactly one ____ placeholder per blank entry.");
    }
  }
  return freeze(issues);
}

/** @param {unknown} value */
export function quizPairSchema(value) {
  if (value !== true) throw new TypeError("Quiz pair schema selector is invalid.");
  const string = { type: "string", minLength: 1 };
  const stringListSchema = { type: "array", minItems: 1, items: string };
  const draftSchema = { type: "object", additionalProperties: false, properties: {
    knowledgeId: string, knowledgeRevision: { type: "integer", minimum: 1 }, canonicalAnswers: { type: "array", description: "Choose one to four distinct compact terms or short phrases, each the exact answer text for one fill-blank position. Use the same ordered answers in correctOptionAnswers and fillBlank.blanks; do not list a combined phrase here when a blank asks for only one part. A single-choice quiz has one answer, one correct key and one blank; a multi-select quiz has one unique correct key and one blank per answer.", minItems: 1, maxItems: 4, items: { type: "string", minLength: 1, maxLength: 300 } }, citedEvidenceUrls: stringListSchema,
    multipleChoice: { type: "object", additionalProperties: false, properties: { prompt: string, options: { type: "array", minItems: 2, maxItems: 8, items: { type: "object", additionalProperties: false, properties: { key: string, text: string }, required: ["key", "text"] } }, correctOptionKeys: { ...stringListSchema, description: "Exactly one distinct existing option key per canonical answer and blank, in the same order as correctOptionAnswers and canonicalAnswers. The count must equal canonicalAnswers.length and fillBlank.blanks.length. Never repeat a key or map several canonical answers to one correct key." }, correctOptionAnswers: { type: "array", description: "One entry per canonical answer, in canonicalAnswers order. Each key must equal correctOptionKeys at the same index and uniquely identify a correct option; canonicalAnswer must be the exact same answer text as canonicalAnswers and fillBlank.blanks at that index, not the fuller option wording or a combined list.", minItems: 1, maxItems: 4, items: { type: "object", additionalProperties: false, properties: { key: string, canonicalAnswer: string }, required: ["key", "canonicalAnswer"] } }, explanation: string }, required: ["prompt", "options", "correctOptionKeys", "correctOptionAnswers", "explanation"] },
    fillBlank: { type: "object", additionalProperties: false, properties: { prompt: string, blanks: { type: "array", description: "Exactly one blank per canonical answer and correct option key, in prompt order, with sequential ids blank-1 onward and one ____ in the prompt per entry. At each index canonicalAnswer and acceptedAnswers[0] must be exactly canonicalAnswers at that index and the corresponding correctOptionAnswers answer text. Each answer must fill its actual sentence grammatically; do not substitute a subset, combined answer or explanatory statement.", minItems: 1, maxItems: 4, items: { type: "object", additionalProperties: false, properties: { id: string, canonicalAnswer: string, acceptedAnswers: { type: "array", description: "The exact canonical answer alone is sufficient. Synonyms are optional; begin with the exact canonical answer and include only distinct legitimate synonyms, never cosmetic glyph or Unicode variants that normalize to an existing entry. All entries must be unique after Unicode NFKC normalization, trimming, case folding and collapsing whitespace: capitalization, compatibility-character and whitespace variants are duplicates, not extra aliases.", minItems: 1, maxItems: 12, items: string } }, required: ["id", "canonicalAnswer", "acceptedAnswers"] } }, explanation: string }, required: ["prompt", "blanks", "explanation"] },
  }, required: ["knowledgeId", "knowledgeRevision", "canonicalAnswers", "citedEvidenceUrls", "multipleChoice", "fillBlank"] };
  return Object.freeze({ name: "paired_quiz_v3", schema: Object.freeze(draftSchema) });
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
