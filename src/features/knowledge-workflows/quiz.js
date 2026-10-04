// @ts-check

import { validateAssembledQuizPair } from "./quiz-pair.js";

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */
/** @typedef {import("./extraction.js").KnowledgePoint} KnowledgePoint */
/** @typedef {"single-choice" | "multiple-choice" | "fill-blank" | "short-response" | "case-study" | "symbolic" | "notation"} QuizKind */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly knowledgeId: string,
 *   readonly knowledgeRevision: number,
 *   readonly kind: QuizKind,
 *   readonly prompt: string,
 *   readonly options: readonly string[],
 *   readonly answer: string | readonly string[],
 *   readonly blanks?: readonly { readonly id: string, readonly acceptedAnswers: readonly string[] }[],
 *   readonly explanation?: string,
 *   readonly citedEvidenceUrls: readonly string[],
 *   readonly pairedQuiz?: { readonly multipleChoice: { readonly id: string, readonly kind: "single-choice"|"multiple-choice", readonly prompt: string, readonly options: readonly {readonly key:string,readonly text:string}[], readonly correctOptionKeys: readonly string[], readonly canonicalAnswers: readonly string[], readonly explanation: string }, readonly fillBlank: { readonly id:string,readonly kind:"fill-blank",readonly prompt:string,readonly blanks:readonly {readonly id:string,readonly canonicalAnswer:string,readonly acceptedAnswers:readonly string[]}[], readonly canonicalAnswers:readonly string[], readonly explanation:string }, readonly canonicalAnswers:readonly string[], readonly citedEvidenceUrls:readonly string[] }
 * }} QuestionDraft
 */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly ownerId: string,
 *   readonly runId: string,
 *   readonly knowledgeId: string,
 *   readonly attempt: number,
 *   readonly draftId: string | null,
 *   readonly score: number | null,
 *   readonly feedback: string | null,
 *   readonly failureKind: string | null,
 *   readonly createdAt: string
 * }} QuizAttempt
 */

/** @typedef {{ readonly knowledgeId: string, readonly status: "accepted" | "abandoned", readonly publicationStatus: "published" | "pending-review" | null, readonly attempts: number, readonly failureKind: string | null, readonly restrictedUntil: string | null }} QuizDisposition */
/** @typedef {{ readonly dispositions: readonly QuizDisposition[] }} QuizRunResult */

/**
 * @typedef {{
 *   readonly kind: "QuizCommandInvalid",
 *   readonly field: string
 * } | {
 *   readonly kind: "QuizGeneratorFailed"
 * } | {
 *   readonly kind: "QuizDuplicate"
 * } | {
 *   readonly kind: "QuizDraftSchemaInvalid"
 * } | {
 *   readonly kind: "QuizDraftUngrounded"
 * } | {
 *   readonly kind: "QuizEvaluatorFailed"
 * } | {
 *   readonly kind: "QuizEvaluatorOutputInvalid"
 * } | {
 *   readonly kind: "QuizScoreBelowThreshold"
 * } | {
 *   readonly kind: "QuizAttemptLimitReached"
 * } | {
 *   readonly kind: "QuizPublicationFailed"
 * } | {
 *   readonly kind: "QuizRestrictionPersistenceFailed"
 * } | {
 *   readonly kind: "QuizPurgeFailed"
 * } | {
 *   readonly kind: "QuizPurgeBeforeRestrictionExpired"
 * } | {
 *   readonly kind: "QuizPersistenceFailed"
 * }} QuizFailure
 */

/** @typedef {{ readonly generate: (command: { readonly knowledge: KnowledgePoint, readonly attempt: number, readonly feedback: string | null }) => Promise<Result<unknown, unknown>> }} QuestionGenerator */
/** @typedef {{ readonly evaluate: (command: { readonly draft: QuestionDraft, readonly knowledge: { readonly id: string, readonly summary: string, readonly evidenceAnchors: readonly { readonly url: string, readonly selector: string }[] }, readonly deterministicValidation: { readonly ok: true }, readonly attempt: number, readonly rubric: string }) => Promise<Result<unknown, unknown>> }} QuestionEvaluator */
/**
 * @typedef {{
 *   readonly findPublished: (scope: {readonly ownerId:string,readonly runId:string,readonly knowledgeId:string}) => Promise<Result<{readonly status:"published"|"pending-review",readonly attempt:number}|null,unknown>>,
 *   readonly appendAttempt: (attempt: QuizAttempt) => Promise<Result<null, unknown>>,
 *   readonly publish: (command: { readonly ownerId: string, readonly runId: string, readonly knowledge: KnowledgePoint, readonly draft: QuestionDraft, readonly score: number, readonly attempt: number, readonly status: "published" | "pending-review" }) => Promise<Result<null, unknown>>,
 *   readonly restrict: (command: { readonly ownerId: string, readonly runId: string, readonly knowledgeId: string, readonly restrictedUntil: string, readonly reason: string }) => Promise<Result<null, unknown>>,
 *   readonly discard: (command: { readonly ownerId: string, readonly runId: string, readonly knowledgeId: string, readonly reason: "no-meaningful-quiz" }) => Promise<Result<null, unknown>>,
 *   readonly purge: (command: { readonly ownerId: string, readonly runId: string, readonly knowledgeId: string, readonly before: string }) => Promise<Result<null, unknown>>
 * }} QuizRepository
 */
/** @typedef {{ readonly generator: QuestionGenerator, readonly evaluator: QuestionEvaluator, readonly repository: QuizRepository, readonly now: () => string, readonly logger: (entry: { readonly event: string, readonly runId?: string, readonly knowledgeId?: string, readonly failureKind?: string }) => void, readonly maxAttempts: number, readonly publicationPolicy?: { readonly samplingVersion: string, readonly factualSamplingRatePercent: number } }} QuizDependencies */

const freeze = Object.freeze;
const acceptedKinds = new Set(["single-choice", "multiple-choice", "fill-blank", "short-response", "case-study", "symbolic", "notation"]);
const factualKinds = new Set(["single-choice", "multiple-choice", "fill-blank"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value @returns {value is number} */
function positiveInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
/** @param {unknown} value @returns {boolean} */
function score(value) { return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10; }
/** @param {unknown} value @returns {value is QuizKind} */
function quizKind(value) { return typeof value === "string" && acceptedKinds.has(value); }

/** @param {unknown} value @returns {value is QuestionDraft} */
function validDraft(value) {
  if (record(value) && value.explanation !== undefined && (!text(value.explanation) || value.explanation.length > 4000)) return false;
  if (record(value) && value.blanks !== undefined && (!Array.isArray(value.blanks) || value.blanks.length < 2 || value.blanks.length > 4 || value.blanks.some((blank, index) => !record(blank) || blank.id !== `blank-${index + 1}` || !Array.isArray(blank.acceptedAnswers) || blank.acceptedAnswers.length === 0 || !blank.acceptedAnswers.every(text)))) return false;
  return record(value) && text(value.id) && text(value.knowledgeId) && positiveInteger(value.knowledgeRevision) && quizKind(value.kind) && text(value.prompt) && Array.isArray(value.options) && value.options.every(text) && Array.isArray(value.citedEvidenceUrls) && value.citedEvidenceUrls.length > 0 && value.citedEvidenceUrls.every(text) && ((typeof value.answer === "string" && text(value.answer)) || (Array.isArray(value.answer) && value.answer.length > 0 && value.answer.every(text)));
}

/** @param {unknown} value @returns {value is { readonly score: number, readonly reasons: readonly string[], readonly feedback: string, readonly groundingProblems: readonly string[] }} */
function validEvaluation(value) {
  return record(value) && score(value.score) && Array.isArray(value.reasons) && value.reasons.length > 0 && value.reasons.every(text) && text(value.feedback) && Array.isArray(value.groundingProblems) && value.groundingProblems.every(text);
}

/** @param {QuestionDraft} draft @param {KnowledgePoint} knowledge @returns {QuizFailure | null} */
function validateGrounding(draft, knowledge) {
  if (draft.knowledgeId !== knowledge.id || draft.knowledgeRevision !== knowledge.sourceRevision) return { kind: "QuizDraftSchemaInvalid" };
  const evidence = new Set(knowledge.evidenceAnchors.map((anchor) => anchor.url));
  if (draft.citedEvidenceUrls.some((url) => !evidence.has(url))) return { kind: "QuizDraftUngrounded" };
  if (draft.pairedQuiz !== undefined && (!validateAssembledQuizPair(draft.pairedQuiz) || draft.pairedQuiz.citedEvidenceUrls.length === 0 || draft.pairedQuiz.citedEvidenceUrls.some((url) => !evidence.has(url)) || draft.kind !== draft.pairedQuiz.multipleChoice.kind || draft.prompt !== draft.pairedQuiz.multipleChoice.prompt)) return { kind: "QuizDraftSchemaInvalid" };
  if (new Set(draft.options.map((option) => option.normalize("NFKC").trim().toLocaleLowerCase())).size !== draft.options.length) return { kind: "QuizDraftSchemaInvalid" };
  if (draft.kind === "single-choice" && (draft.options.length < 2 || typeof draft.answer !== "string" || !draft.options.includes(draft.answer))) return { kind: "QuizDraftSchemaInvalid" };
  if (draft.kind === "multiple-choice" && (draft.options.length < 2 || !Array.isArray(draft.answer) || draft.answer.length >= draft.options.length || new Set(draft.answer).size !== draft.answer.length || draft.answer.some((answer) => !draft.options.includes(answer)))) return { kind: "QuizDraftSchemaInvalid" };
  if (draft.kind === "fill-blank") {
    if (draft.options.length !== 0 || (draft.blanks !== undefined && (!Array.isArray(draft.answer) || draft.answer.length !== draft.blanks.length || draft.blanks.some((blank, index) => blank.acceptedAnswers[0] !== draft.answer[index]) || (draft.prompt.match(/_{2,}/gu) ?? []).length !== draft.blanks.length))) return { kind: "QuizDraftSchemaInvalid" };
  } else if (draft.blanks !== undefined) return { kind: "QuizDraftSchemaInvalid" };
  return null;
}

/** @param {unknown} command @returns {command is { readonly ownerId: string, readonly runId: string, readonly points: readonly KnowledgePoint[] }} */
function validCommand(command) {
  return record(command) && text(command.ownerId) && text(command.runId) && Array.isArray(command.points) && command.points.every((point) => record(point) && text(point.id) && text(point.sourceId) && positiveInteger(point.sourceRevision) && text(point.summary) && Array.isArray(point.evidenceAnchors));
}

/** @param {string} _ownerId @param {KnowledgePoint} _knowledge @param {QuestionDraft} _draft @param {{ readonly samplingVersion: string, readonly factualSamplingRatePercent: number }} _policy @returns {"published"} */
function publicationStatus(_ownerId, _knowledge, _draft, _policy) {
  return "published";
}

/** @param {QuizFailure} failure @param {QuizDependencies} dependencies @param {string} runId @param {string | undefined} knowledgeId @returns {Result<never, QuizFailure>} */
function fail(failure, dependencies, runId, knowledgeId) { dependencies.logger({ event: "quiz-actor-critic-failure", runId, knowledgeId, failureKind: failure.kind }); return { ok: false, error: failure }; }

/** @param {QuizDependencies} dependencies */
export function createQuizActorCritic(dependencies) {
  const policy = dependencies?.publicationPolicy ?? { samplingVersion: "factual-sampling-v1", factualSamplingRatePercent: 30 };
  if (!dependencies || typeof dependencies.generator?.generate !== "function" || typeof dependencies.evaluator?.evaluate !== "function" || typeof dependencies.repository?.findPublished !== "function" || typeof dependencies.repository.appendAttempt !== "function" || typeof dependencies.repository.publish !== "function" || typeof dependencies.repository.discard !== "function" || typeof dependencies.repository.purge !== "function" || typeof dependencies.now !== "function" || typeof dependencies.logger !== "function" || dependencies.maxAttempts !== 3 || !text(policy.samplingVersion) || !Number.isInteger(policy.factualSamplingRatePercent) || policy.factualSamplingRatePercent < 0 || policy.factualSamplingRatePercent > 100) throw new TypeError("Quiz actor-critic dependencies are invalid.");
  return Object.freeze({
    /** @param {unknown} command @returns {Promise<Result<QuizRunResult, QuizFailure>>} */
    async run(command) {
      if (!validCommand(command)) return fail({ kind: "QuizCommandInvalid", field: "command" }, dependencies, "unknown", undefined);
      dependencies.logger({ event: "quiz-actor-critic-entry", runId: command.runId });
      /** @type {QuizDisposition[]} */
      const dispositions = [];
      for (const knowledge of command.points) {
        let existing;
        try { existing = await dependencies.repository.findPublished({ownerId:command.ownerId,runId:command.runId,knowledgeId:knowledge.id}); }
        catch (error) { if (!(error instanceof Error)) throw error; return fail({kind:"QuizPersistenceFailed"},dependencies,command.runId,knowledge.id); }
        if (!existing.ok) return fail({kind:"QuizPersistenceFailed"},dependencies,command.runId,knowledge.id);
        if (existing.value !== null) {
          if ((existing.value.status !== "published" && existing.value.status !== "pending-review") || !Number.isSafeInteger(existing.value.attempt) || existing.value.attempt < 1 || existing.value.attempt > dependencies.maxAttempts) return fail({kind:"QuizPersistenceFailed"},dependencies,command.runId,knowledge.id);
          dispositions.push(freeze({knowledgeId:knowledge.id,status:"accepted",publicationStatus:existing.value.status,attempts:existing.value.attempt,failureKind:null,restrictedUntil:null}));
          dependencies.logger({event:"quiz-actor-critic-reused",runId:command.runId,knowledgeId:knowledge.id});
          continue;
        }
        let feedback = null;
        let lastFailure = /** @type {QuizFailure["kind"] | null} */ (null);
        let attempts = 0;
        let accepted = false;
        /** @type {"published" | "pending-review" | null} */
        let acceptedPublicationStatus = null;
        for (let attempt = 1; attempt <= dependencies.maxAttempts; attempt += 1) {
          attempts = attempt;
          let generated;
          try { generated = await dependencies.generator.generate({ knowledge, attempt, feedback }); } catch (error) {
            lastFailure = "QuizGeneratorFailed";
            const saved = await persistAttempt(dependencies.repository, { ownerId: command.ownerId, runId: command.runId, knowledgeId: knowledge.id, attempt, draftId: null, score: null, feedback: null, failureKind: lastFailure, createdAt: dependencies.now() }, dependencies, command.runId, knowledge.id);
            if (!saved.ok) return saved;
            feedback = "Regenerate a schema-valid, evidence-grounded draft.";
            continue;
          }
          if (!generated.ok) {
            lastFailure = record(generated.error) && generated.error.kind === "QuizDuplicate" ? "QuizDuplicate" : "QuizGeneratorFailed";
            if (lastFailure === "QuizDuplicate") break;
            const saved = await persistAttempt(dependencies.repository, { ownerId: command.ownerId, runId: command.runId, knowledgeId: knowledge.id, attempt, draftId: null, score: null, feedback: null, failureKind: lastFailure, createdAt: dependencies.now() }, dependencies, command.runId, knowledge.id);
            if (!saved.ok) return saved;
            feedback = "Regenerate a schema-valid, evidence-grounded draft.";
            continue;
          }
          if (!validDraft(generated.value)) {
            lastFailure = "QuizDraftSchemaInvalid";
            const saved = await persistAttempt(dependencies.repository, { ownerId: command.ownerId, runId: command.runId, knowledgeId: knowledge.id, attempt, draftId: null, score: null, feedback: null, failureKind: lastFailure, createdAt: dependencies.now() }, dependencies, command.runId, knowledge.id);
            if (!saved.ok) return saved;
            feedback = "Regenerate a schema-valid, evidence-grounded draft.";
            continue;
          }
          const draft = /** @type {QuestionDraft} */ (generated.value);
          const groundingFailure = validateGrounding(draft, knowledge);
          if (groundingFailure !== null) {
            lastFailure = groundingFailure.kind;
            const saved = await persistAttempt(dependencies.repository, { ownerId: command.ownerId, runId: command.runId, knowledgeId: knowledge.id, attempt, draftId: draft.id, score: null, feedback: null, failureKind: lastFailure, createdAt: dependencies.now() }, dependencies, command.runId, knowledge.id);
            if (!saved.ok) return saved;
            feedback = "Use only the knowledge point's cited evidence.";
            continue;
          }
          let evaluated;
          try { evaluated = await dependencies.evaluator.evaluate({ draft, knowledge: { id: knowledge.id, summary: knowledge.summary, evidenceAnchors: knowledge.evidenceAnchors }, deterministicValidation: { ok: true }, attempt, rubric: "10 means the draft tests the key concept precisely; 1 means irrelevant or too general." }); } catch (error) {
            lastFailure = "QuizEvaluatorFailed";
            const saved = await persistAttempt(dependencies.repository, { ownerId: command.ownerId, runId: command.runId, knowledgeId: knowledge.id, attempt, draftId: draft.id, score: null, feedback: null, failureKind: lastFailure, createdAt: dependencies.now() }, dependencies, command.runId, knowledge.id);
            if (!saved.ok) return saved;
            feedback = "Regenerate the question after evaluator failure.";
            continue;
          }
          if (!evaluated.ok || !validEvaluation(evaluated.value)) {
            lastFailure = "QuizEvaluatorOutputInvalid";
            const saved = await persistAttempt(dependencies.repository, { ownerId: command.ownerId, runId: command.runId, knowledgeId: knowledge.id, attempt, draftId: draft.id, score: null, feedback: null, failureKind: lastFailure, createdAt: dependencies.now() }, dependencies, command.runId, knowledge.id);
            if (!saved.ok) return saved;
            feedback = "Return a score, reasons, actionable feedback, and grounding problems.";
            continue;
          }
          const evaluation = evaluated.value;
          lastFailure = evaluation.score >= 8 && evaluation.groundingProblems.length === 0 ? null : evaluation.score >= 8 ? "QuizDraftUngrounded" : "QuizScoreBelowThreshold";
          const saved = await persistAttempt(dependencies.repository, { ownerId: command.ownerId, runId: command.runId, knowledgeId: knowledge.id, attempt, draftId: draft.id, score: evaluation.score, feedback: evaluation.feedback, failureKind: lastFailure, createdAt: dependencies.now() }, dependencies, command.runId, knowledge.id);
          if (!saved.ok) return saved;
          if (evaluation.score >= 8 && evaluation.groundingProblems.length === 0) {
            const status = publicationStatus(command.ownerId, knowledge, draft, policy);
            let published;
            try { published = await dependencies.repository.publish({ ownerId: command.ownerId, runId: command.runId, knowledge, draft, score: evaluation.score, attempt, status }); } catch (error) { return fail({ kind: "QuizPublicationFailed" }, dependencies, command.runId, knowledge.id); }
            if (!published.ok) {
              if (record(published.error) && published.error.kind === "QuizDuplicate") {
                lastFailure = "QuizDuplicate";
                break;
              }
              return fail({ kind: "QuizPublicationFailed" }, dependencies, command.runId, knowledge.id);
            }
            accepted = true;
            acceptedPublicationStatus = status;
            break;
          }
          feedback = evaluation.feedback;
        }
        if (accepted) {
          dispositions.push(freeze({ knowledgeId: knowledge.id, status: "accepted", publicationStatus: acceptedPublicationStatus, attempts, failureKind: null, restrictedUntil: null }));
          continue;
        }
        try {
          const discarded = await dependencies.repository.discard({ ownerId: command.ownerId, runId: command.runId, knowledgeId: knowledge.id, reason: "no-meaningful-quiz" });
          if (!discarded.ok) return fail({ kind: "QuizPurgeFailed" }, dependencies, command.runId, knowledge.id);
        } catch (error) { return fail({ kind: "QuizPurgeFailed" }, dependencies, command.runId, knowledge.id); }
        dispositions.push(freeze({ knowledgeId: knowledge.id, status: "abandoned", publicationStatus: null, attempts, failureKind: lastFailure, restrictedUntil: null }));
      }
      dependencies.logger({ event: "quiz-actor-critic-success", runId: command.runId });
      return { ok: true, value: freeze({ dispositions: freeze(dispositions) }) };
    },

    /** @param {unknown} command @returns {Promise<Result<null, QuizFailure>>} */
    async purgeExpired(command) {
      if (!record(command) || !text(command.ownerId) || !text(command.runId) || !text(command.knowledgeId) || !text(command.restrictedUntil) || !text(command.before) || !Number.isFinite(Date.parse(command.restrictedUntil)) || !Number.isFinite(Date.parse(command.before))) return fail({ kind: "QuizCommandInvalid", field: "command" }, dependencies, "unknown", undefined);
      if (Date.parse(command.before) < Date.parse(command.restrictedUntil)) return fail({ kind: "QuizPurgeBeforeRestrictionExpired" }, dependencies, command.runId, command.knowledgeId);
      try { const purged = await dependencies.repository.purge({ ownerId: command.ownerId, runId: command.runId, knowledgeId: command.knowledgeId, before: command.before }); return purged.ok ? purged : fail({ kind: "QuizPurgeFailed" }, dependencies, command.runId, command.knowledgeId); } catch (error) { return fail({ kind: "QuizPurgeFailed" }, dependencies, command.runId, command.knowledgeId); }
    },
  });
}

/** @param {QuizRepository} repository @param {Omit<QuizAttempt, "id">} attempt @param {QuizDependencies} dependencies @param {string} runId @param {string} knowledgeId @returns {Promise<Result<null, QuizFailure>>} */
async function persistAttempt(repository, attempt, dependencies, runId, knowledgeId) {
  try { const result = await repository.appendAttempt(Object.freeze({ id: `quiz-attempt:${crypto.randomUUID()}`, ...attempt })); return result.ok ? result : fail({ kind: "QuizPersistenceFailed" }, dependencies, runId, knowledgeId); } catch (error) { return fail({ kind: "QuizPersistenceFailed" }, dependencies, runId, knowledgeId); }
}

export {};
