// @ts-check

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly priority: "high" | "normal",
 *   readonly description: string
 * }} ExtractionGap
 */

/**
 * @typedef {{
 *   readonly revision: number,
 *   readonly frontier: readonly string[],
 *   readonly coverageGoals: readonly { readonly id: string, readonly priority: "high" | "normal", readonly description: string }[],
 *   readonly unresolvedGaps: readonly ExtractionGap[],
 *   readonly stopDecision: ExtractionStopDecision
 * }} ExtractionPlan
 */

/**
 * @typedef {{
 *   readonly decision: "continue" | "complete" | "blocked",
 *   readonly rationale: string,
 *   readonly evidenceUrls: readonly string[],
 *   readonly unresolvedGapIds: readonly string[]
 * }} ExtractionStopDecision
 */

/**
 * @typedef {{
 *   readonly url: string,
 *   readonly selector: string,
 *   readonly blockId?: string,
 *   readonly visibleEvidence?: string,
 *   readonly quote?: string,
 *   readonly clause?: string,
 *   readonly quoteDigest?: string
 * }} EvidenceAnchor
 */

/**
 * @typedef {{
 *   readonly comparedLocalHash: string,
 *   readonly score: number,
 *   readonly decision: "distinct" | "merge" | "ambiguous"
 * }} SimilarityEvidence
 */

/** @typedef {{ readonly visualId: string }} VisualMediaReference */

/**
 * @typedef {{
 *   readonly summary: string,
 *   readonly normalizedHash: string,
 *   readonly evidenceAnchors: readonly EvidenceAnchor[],
 *   readonly coverageGoalIds: readonly string[],
 *   readonly mediaCandidates: readonly (VisualMediaReference | unknown)[],
 *   readonly classification?: unknown,
 *   readonly similarity?: SimilarityEvidence
 * }} KnowledgeCandidate
 */

/**
 * @typedef {{
 *   readonly url: string,
 *   readonly responseUrl?: string,
 *   readonly title: string,
 *   readonly byteCount: number,
 *   readonly redirects: number,
 *   readonly links: readonly string[],
 *   readonly observedAt: string,
 *   readonly candidates: readonly KnowledgeCandidate[],
 *   readonly notes?: string
 }} PageObservation
 */

/** @typedef {{ readonly url: string, readonly title: string, readonly note: string, readonly observedAt: string, readonly linkCount: number, readonly candidateCount: number }} ExtractionPageNote */

/**
 * @typedef {{
 *   readonly id: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly summary: string,
 *   readonly normalizedHash: string,
 *   readonly evidenceAnchors: readonly EvidenceAnchor[],
 *   readonly coverageGoalIds: readonly string[],
 *   readonly mediaCandidates: readonly (VisualMediaReference | unknown)[],
 *   readonly attribution: { readonly sourceUrl: string },
 *   readonly extractionVersion: string,
 *   readonly classification?: unknown
 * }} KnowledgePoint
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly runId: string,
 *   readonly sourceId: string,
 *   readonly sourceRevision: number,
 *   readonly processedUrls: readonly string[],
 *   readonly frontier?: readonly string[],
 *   readonly discoveredUrls?: readonly string[],
 *   readonly acceptedHashes: readonly string[],
 *   readonly reviewedCandidateCount?: number,
 *   readonly similarityEvidence: readonly { readonly candidateHash: string, readonly comparedLocalHash: string, readonly score: number, readonly decision: SimilarityEvidence["decision"] }[],
 *   readonly coverage: readonly string[],
 *   readonly unresolvedGaps: readonly ExtractionGap[],
 *   readonly consecutiveNoveltyZero: number,
 *   readonly pageNotes?: readonly ExtractionPageNote[],
 *   readonly pendingBatch?: { readonly key: string, readonly plan: ExtractionPlan, readonly observations: readonly PageObservation[] },
 *   readonly revision: number
 * }} ExtractionScratchpad
 */

/**
 * @typedef {{
 *   readonly state: "completed" | "paused" | "awaiting-time-limit-decision",
 *   readonly scratchpad: ExtractionScratchpad,
 *   readonly knowledgePointCount: number,
 *   readonly pagesProcessed: number,
 *   readonly stopReason?: "agent-complete" | "agent-blocked" | "time-limit" | "paused"
 * }} ExtractionResult
 */

/**
 * @typedef {{
 *   readonly kind: "ExtractionCommandInvalid",
 *   readonly field: string
 * } | {
 *   readonly kind: "ExtractionRightsNotAllowed"
 * } | {
 *   readonly kind: "ExtractionRobotsNotAllowed"
 * } | {
 *   readonly kind: "ExtractionPlanInvalid"
 * } | {
 *   readonly kind: "ExtractionPlannerFailed"
 * } | {
 *   readonly kind: "ExtractionAcquisitionFailed",
 *   readonly causeKind?: string,
 *   readonly diagnosticToken?: string
 * } | {
 *   readonly kind: "ExtractionObservationInvalid",
 *   readonly field: string
 * } | {
 *   readonly kind: "UnsafeDestination"
 * } | {
 *   readonly kind: "ExtractionLimitExceeded",
 *   readonly limit: "frontier" | "page-bytes" | "redirects" | "pages"
 * } | {
 *   readonly kind: "KnowledgeDuplicateAmbiguous"
 * } | {
 *   readonly kind: "KnowledgePersistenceFailed",
 *   readonly causeKind?: string
 * } | {
 *   readonly kind: "ScratchpadPersistenceFailed"
 * } | {
 *   readonly kind: "ScraperMemoryPersistenceFailed"
 * } | {
 *   readonly kind: "KnowledgeSetEmpty"
 * } | {
 *   readonly kind: "ExtractionCoverageIncomplete"
 * } | {
 *   readonly kind: "ExtractionStopped"
 * }} ExtractionFailure
 */

/** @typedef {{ readonly status: "allowed" | "awaiting-review" | "denied", readonly sourceId: string, readonly sourceRevision: number }} RightsGateResult */
/** @typedef {{ readonly status: "allowed" | "denied" }} RobotsGateResult */

/**
 * @typedef {{
 *   readonly plan: (command: { readonly rootUrl: string, readonly scratchpad: ExtractionScratchpad }) => Promise<Result<ExtractionPlan, unknown>>,
 *   readonly replan: (command: { readonly previous: ExtractionPlan, readonly observation: PageObservation, readonly scratchpad: ExtractionScratchpad }) => Promise<Result<ExtractionPlan, unknown>>
 * }} ExtractionPlanner
 */
/** @typedef {{ readonly fetchPage: (command: { readonly url: string, readonly rootUrl: string, readonly plan: ExtractionPlan }) => Promise<Result<PageObservation, unknown>> }} PageAcquirer */
/** @typedef {{ readonly load: (scope: { readonly ownerId: string, readonly runId: string, readonly sourceId: string, readonly sourceRevision: number }) => Promise<Result<ExtractionScratchpad, unknown>>, readonly save: (scratchpad: ExtractionScratchpad) => Promise<Result<null, unknown>> }} ScratchpadRepository */
/** @typedef {{ readonly append: (point: KnowledgePoint) => Promise<Result<null, unknown>> }} KnowledgeRepository */
/** @typedef {{ readonly append: (record: { readonly kind: "durable-fact" | "decision" | "unresolved", readonly retention: "source" | "run", readonly payload: unknown }) => Promise<Result<null, unknown>> }} ExtractionMemory */

/**
 * @typedef {{
 *   readonly rights: RightsGateResult,
 *   readonly robots: RobotsGateResult,
 *   readonly planner: ExtractionPlanner,
 *   readonly acquirer: PageAcquirer,
 *   readonly batchAcquirer?: { readonly key: string, readonly maximumBatchSize?: number, readonly fetchBatch: (command: { readonly urls: readonly string[], readonly rootUrl: string, readonly plan: ExtractionPlan, readonly scratchpad: ExtractionScratchpad }) => Promise<Result<readonly PageObservation[], unknown>> },
 *   readonly checkRobots?: (targetUrl: string) => Promise<Result<unknown, unknown>>,
 *   readonly scratchpad: ScratchpadRepository,
 *   readonly knowledge: KnowledgeRepository,
 *   readonly reviewer?: { readonly review: (point: KnowledgePoint, observation: PageObservation) => Promise<Result<KnowledgePoint | null, { readonly kind: string }>> },
 *   readonly memory?: ExtractionMemory,
 *   readonly now: () => string,
 *   readonly nowMs: () => number,
 *   readonly logger: (entry: { readonly event: string, readonly runId?: string, readonly failureKind?: string, readonly diagnosticToken?: string }) => void,
 *   readonly stopRequested?: () => boolean,
 *   readonly policy: { readonly maximumFrontier: number, readonly maximumPageBytes: number, readonly maximumRedirects: number, readonly maximumPages: number, readonly maximumDurationMs: number, readonly maximumPagesPerExecution?: number }
 * }} ExtractionDependencies
 */

/** @typedef {{ readonly ownerId: string, readonly runId: string, readonly sourceId: string, readonly sourceRevision: number, readonly rootUrl: string, readonly startedAtMs: number, readonly deadlineAtMs: number }} ExtractionCommand */

const freeze = Object.freeze;
const extractionVersion = "knowledge-extraction-v1";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value @returns {value is number} */
function positiveInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
/** @param {unknown} value @returns {boolean} */
function nonNegativeInteger(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
/** @param {unknown} value @returns {boolean} */
function timestamp(value) { return text(value) && Number.isFinite(Date.parse(value)); }
/** @param {unknown} value @returns {boolean} */
function publicHttps(value) { return text(value) && URL.canParse(value) && new URL(value).protocol === "https:"; }

/** @param {unknown} value @returns {value is ExtractionGap} */
function validGap(value) { return isRecord(value) && text(value.id) && (value.priority === "high" || value.priority === "normal") && text(value.description); }

/** @param {unknown} value @returns {value is ExtractionPlan} */
function validPlan(value) {
  if (!isRecord(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["coverageGoals", "frontier", "revision", "stopDecision", "unresolvedGaps"]) || !positiveInteger(value.revision) || !Array.isArray(value.frontier) || !value.frontier.every(publicHttps) || !validStopDecision(value.stopDecision)) return false;
  const validGoal = (/** @type {unknown} */ goal) => isRecord(goal) && JSON.stringify(Object.keys(goal).sort()) === JSON.stringify(["description", "id", "priority"]) && text(goal.id) && (goal.priority === "high" || goal.priority === "normal") && text(goal.description);
  const validGap = (/** @type {unknown} */ gap) => isRecord(gap) && JSON.stringify(Object.keys(gap).sort()) === JSON.stringify(["description", "id", "priority"]) && text(gap.id) && (gap.priority === "high" || gap.priority === "normal") && text(gap.description);
  return Array.isArray(value.coverageGoals) && value.coverageGoals.every(validGoal) && Array.isArray(value.unresolvedGaps) && value.unresolvedGaps.every(validGap);
}

/** @param {unknown} value @returns {value is ExtractionStopDecision} */
function validStopDecision(value) {
  return isRecord(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["decision", "evidenceUrls", "rationale", "unresolvedGapIds"]) && (value.decision === "continue" || value.decision === "complete" || value.decision === "blocked") && text(value.rationale) && value.rationale.length <= 2_000 && Array.isArray(value.evidenceUrls) && value.evidenceUrls.length <= 50 && value.evidenceUrls.every(publicHttps) && Array.isArray(value.unresolvedGapIds) && value.unresolvedGapIds.length <= 100 && value.unresolvedGapIds.every(text);
}

/** @param {unknown} value @returns {value is EvidenceAnchor} */
function validAnchor(value) { return isRecord(value) && (JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["selector", "url"]) || JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["selector", "url", "visibleEvidence"]) && text(value.visibleEvidence) && value.visibleEvidence.length <= 500 || JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["quoteDigest", "selector", "url"]) || JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["blockId", "clause", "quote", "quoteDigest", "selector", "url"])) && publicHttps(value.url) && text(value.selector) && (value.quoteDigest === undefined || text(value.quoteDigest)) && (value.blockId === undefined || text(value.blockId) && text(value.quote) && text(value.clause)); }
/** @param {unknown} value @returns {value is SimilarityEvidence} */
function validSimilarity(value) { return isRecord(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["comparedLocalHash", "decision", "score"]) && text(value.comparedLocalHash) && typeof value.score === "number" && value.score >= 0 && value.score <= 1 && (value.decision === "distinct" || value.decision === "merge" || value.decision === "ambiguous"); }
/** @param {unknown} value @returns {value is VisualMediaReference} */
function validVisualMediaReference(value) { return isRecord(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["visualId"]) && text(value.visualId); }
/** @param {unknown} value @returns {value is KnowledgeCandidate} */
function validCandidate(value) { return isRecord(value) && (JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["coverageGoalIds", "evidenceAnchors", "mediaCandidates", "normalizedHash", "summary"]) || JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["coverageGoalIds", "evidenceAnchors", "mediaCandidates", "normalizedHash", "similarity", "summary"]) || JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["classification", "coverageGoalIds", "evidenceAnchors", "mediaCandidates", "normalizedHash", "summary"]) || JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["classification", "coverageGoalIds", "evidenceAnchors", "mediaCandidates", "normalizedHash", "similarity", "summary"])) && text(value.summary) && text(value.normalizedHash) && Array.isArray(value.evidenceAnchors) && value.evidenceAnchors.length > 0 && value.evidenceAnchors.every(validAnchor) && Array.isArray(value.coverageGoalIds) && value.coverageGoalIds.every(text) && Array.isArray(value.mediaCandidates) && value.mediaCandidates.length <= 1 && (value.similarity === undefined || validSimilarity(value.similarity)); }
/** @param {unknown} value @returns {value is PageObservation} */
function validObservation(value) { return isRecord(value) && publicHttps(value.url) && (value.responseUrl===undefined||publicHttps(value.responseUrl)) && text(value.title) && nonNegativeInteger(value.byteCount) && nonNegativeInteger(value.redirects) && Array.isArray(value.links) && value.links.every(publicHttps) && timestamp(value.observedAt) && Array.isArray(value.candidates) && value.candidates.every(validCandidate) && (value.notes === undefined || (typeof value.notes === "string" && value.notes.length <= 2_000)); }

/** @param {unknown} value @returns {value is ExtractionPageNote} */
function validPageNote(value) { return isRecord(value) && publicHttps(value.url) && (value.responseUrl===undefined||publicHttps(value.responseUrl)) && text(value.title) && text(value.note) && value.note.length <= 2_000 && timestamp(value.observedAt) && nonNegativeInteger(value.linkCount) && nonNegativeInteger(value.candidateCount); }

/** @param {unknown} value @returns {value is ExtractionScratchpad} */
function validScratchpad(value) {
  return isRecord(value) && text(value.ownerId) && text(value.runId) && text(value.sourceId) && positiveInteger(value.sourceRevision) &&
    Array.isArray(value.processedUrls) && value.processedUrls.every(publicHttps) && (value.frontier === undefined || (Array.isArray(value.frontier) && value.frontier.every(publicHttps))) && (value.discoveredUrls === undefined || (Array.isArray(value.discoveredUrls) && value.discoveredUrls.every(publicHttps))) && Array.isArray(value.acceptedHashes) && value.acceptedHashes.every(text) && (value.reviewedCandidateCount === undefined || nonNegativeInteger(value.reviewedCandidateCount)) &&
    Array.isArray(value.similarityEvidence) && value.similarityEvidence.every((entry) => isRecord(entry) && text(entry.candidateHash) && text(entry.comparedLocalHash) && typeof entry.score === "number" && entry.score >= 0 && entry.score <= 1 && (entry.decision === "distinct" || entry.decision === "merge" || entry.decision === "ambiguous")) &&
    Array.isArray(value.coverage) && value.coverage.every(text) && Array.isArray(value.unresolvedGaps) && value.unresolvedGaps.every(validGap) && nonNegativeInteger(value.consecutiveNoveltyZero) && (value.pageNotes === undefined || (Array.isArray(value.pageNotes) && value.pageNotes.length <= 100 && value.pageNotes.every(validPageNote))) && positiveInteger(value.revision) &&
    (value.pendingBatch === undefined || (isRecord(value.pendingBatch) && text(value.pendingBatch.key) && validPlan(value.pendingBatch.plan) && Array.isArray(value.pendingBatch.observations) && value.pendingBatch.observations.length > 0 && value.pendingBatch.observations.length <= 5 && value.pendingBatch.observations.every(validObservation) && new Set(value.pendingBatch.observations.map((page) => page.url)).size === value.pendingBatch.observations.length));
}

/** @param {unknown} command @returns {command is ExtractionCommand} */
function validCommand(command) {
  return isRecord(command) && text(command.ownerId) && text(command.runId) && text(command.sourceId) && positiveInteger(command.sourceRevision) && publicHttps(command.rootUrl) && nonNegativeInteger(command.startedAtMs) && positiveInteger(command.deadlineAtMs) && typeof command.deadlineAtMs === "number" && typeof command.startedAtMs === "number" && command.deadlineAtMs > command.startedAtMs;
}

/** @param {ExtractionScratchpad} value @returns {ExtractionScratchpad} */
function cloneScratchpad(value) {
  return freeze({ ...value, processedUrls: freeze([...value.processedUrls]), frontier: freeze([...(Array.isArray(value.frontier) ? value.frontier : [])]), discoveredUrls: freeze([...(Array.isArray(value.discoveredUrls) ? value.discoveredUrls : [])]), acceptedHashes: freeze([...value.acceptedHashes]), similarityEvidence: freeze(value.similarityEvidence.map((entry) => freeze({ ...entry }))), coverage: freeze([...value.coverage]), unresolvedGaps: freeze(value.unresolvedGaps.map((entry) => freeze({ ...entry }))), pageNotes: freeze((Array.isArray(value.pageNotes) ? value.pageNotes : []).map((entry) => freeze({ ...entry }))) });
}

/** @param {unknown} value @returns {string} */
function acquisitionFailureKind(value) {
  return isRecord(value) && text(value.kind) ? value.kind : "ExtractionAcquisitionFailed";
}

/** @param {unknown} value @returns {{ readonly kind: "ExtractionAcquisitionFailed", readonly causeKind?: string, readonly diagnosticToken?: string }} */
function acquisitionFailure(value) {
  const causeKind = acquisitionFailureKind(value);
  const diagnosticToken = isRecord(value) && typeof value.diagnosticToken === "string" && /^[a-z0-9-]+$/u.test(value.diagnosticToken) ? value.diagnosticToken : undefined;
  return { kind: "ExtractionAcquisitionFailed", ...(causeKind === "ExtractionAcquisitionFailed" ? {} : { causeKind }), ...(diagnosticToken === undefined ? {} : { diagnosticToken }) };
}

/** @param {unknown} value @returns {string | undefined} */
function failureDiagnosticToken(value) {
  return isRecord(value) && typeof value.diagnosticToken === "string" && /^[a-z0-9-]+$/u.test(value.diagnosticToken) ? value.diagnosticToken : undefined;
}

/** @param {ExtractionFailure} failure @param {ExtractionDependencies} dependencies @param {string} runId @returns {Result<never, ExtractionFailure>} */
function fail(failure, dependencies, runId) { const diagnosticToken = failureDiagnosticToken(failure); dependencies.logger({ event: "knowledge-extraction-failure", runId, failureKind: failure.kind, ...(diagnosticToken === undefined ? {} : { diagnosticToken }) }); return { ok: false, error: failure }; }

/** @param {ExtractionMemory | undefined} memory @param {"durable-fact" | "decision" | "unresolved"} kind @param {"source" | "run"} retention @param {unknown} payload @param {ExtractionDependencies} dependencies @param {string} runId @returns {Promise<Result<null, ExtractionFailure>>} */
async function remember(memory, kind, retention, payload, dependencies, runId) {
  if (memory === undefined) return { ok: true, value: null };
  let result;
  try {
    result = await memory.append({ kind, retention, payload });
  } catch (error) {
    return fail({ kind: "ScraperMemoryPersistenceFailed" }, dependencies, runId);
  }
  return result.ok ? { ok: true, value: null } : fail({ kind: "ScraperMemoryPersistenceFailed" }, dependencies, runId);
}

/** @param {ExtractionPlan} plan @param {ExtractionScratchpad} scratchpad @returns {string | null} */
function pendingFrontierUrl(plan, scratchpad) {
  return plan.frontier.find((url) => !scratchpad.processedUrls.includes(url)) ?? null;
}

/** @param {ExtractionPlan} plan @param {ExtractionScratchpad} scratchpad @returns {boolean} */
function planIsComplete(plan, scratchpad) {
  return plan.stopDecision.decision === "complete" && pendingFrontierUrl(plan, scratchpad) === null && coverageComplete(plan, scratchpad) && plan.unresolvedGaps.every((gap) => gap.priority !== "high");
}

/** @param {ExtractionDependencies} dependencies */
export function createExtractionRunner(dependencies) {
  if (!dependencies || !dependencies.rights || !dependencies.robots || dependencies.rights.status === undefined || dependencies.robots.status === undefined ||
    typeof dependencies.planner?.plan !== "function" || typeof dependencies.planner.replan !== "function" || typeof dependencies.acquirer?.fetchPage !== "function" ||
    typeof dependencies.scratchpad?.load !== "function" || typeof dependencies.scratchpad.save !== "function" || typeof dependencies.knowledge?.append !== "function" ||
    typeof dependencies.now !== "function" || typeof dependencies.nowMs !== "function" || typeof dependencies.logger !== "function" ||
    (dependencies.batchAcquirer !== undefined && (!text(dependencies.batchAcquirer.key) || typeof dependencies.batchAcquirer.fetchBatch !== "function" || (dependencies.batchAcquirer.maximumBatchSize !== undefined && (!positiveInteger(dependencies.batchAcquirer.maximumBatchSize) || dependencies.batchAcquirer.maximumBatchSize > 5)))) ||
    !positiveInteger(dependencies.policy?.maximumFrontier) || !positiveInteger(dependencies.policy.maximumPageBytes) || !nonNegativeInteger(dependencies.policy.maximumRedirects) || !positiveInteger(dependencies.policy.maximumPages) || !positiveInteger(dependencies.policy.maximumDurationMs) ||
    (dependencies.policy.maximumPagesPerExecution !== undefined && !positiveInteger(dependencies.policy.maximumPagesPerExecution))) throw new TypeError("Extraction-runner dependencies are invalid.");
  return Object.freeze({
    /** @param {unknown} input @returns {Promise<Result<ExtractionResult, ExtractionFailure>>} */
    async run(input) {
      if (!validCommand(input)) return fail({ kind: "ExtractionCommandInvalid", field: "command" }, dependencies, "unknown");
      const command = /** @type {ExtractionCommand} */ (input);
      if (dependencies.rights.status !== "allowed" || dependencies.rights.sourceId !== command.sourceId || dependencies.rights.sourceRevision !== command.sourceRevision) return fail({ kind: "ExtractionRightsNotAllowed" }, dependencies, command.runId);
      if (dependencies.robots.status !== "allowed") return fail({ kind: "ExtractionRobotsNotAllowed" }, dependencies, command.runId);
      const root = new URL(command.rootUrl);
      const currentMs = dependencies.nowMs();
      if (!Number.isFinite(currentMs) || currentMs < command.startedAtMs) throw new TypeError("Extraction clock returned an invalid instant.");
      if (command.deadlineAtMs - command.startedAtMs > dependencies.policy.maximumDurationMs) return fail({ kind: "ExtractionCommandInvalid", field: "deadlineAtMs" }, dependencies, command.runId);
      let loaded;
      try { loaded = await dependencies.scratchpad.load({ ownerId: command.ownerId, runId: command.runId, sourceId: command.sourceId, sourceRevision: command.sourceRevision }); } catch (error) { return fail({ kind: "ScratchpadPersistenceFailed" }, dependencies, command.runId); }
      if (!loaded.ok || !validScratchpad(loaded.value) || loaded.value.ownerId !== command.ownerId || loaded.value.runId !== command.runId || loaded.value.sourceId !== command.sourceId || loaded.value.sourceRevision !== command.sourceRevision) return fail({ kind: "ScratchpadPersistenceFailed" }, dependencies, command.runId);
      const persistedFrontier = Array.isArray(loaded.value.frontier) ? loaded.value.frontier : [];
      let scratchpad = cloneScratchpad({
        ...loaded.value,
        discoveredUrls: [...new Set([
          ...(Array.isArray(loaded.value.discoveredUrls) ? loaded.value.discoveredUrls : []),
          ...(Array.isArray(loaded.value.frontier) ? loaded.value.frontier : []),
        ])],
      });
      let plan;
      if (scratchpad.pendingBatch !== undefined && scratchpad.pendingBatch.key !== dependencies.batchAcquirer?.key) return fail({ kind: "ExtractionObservationInvalid", field: "pendingBatch.key" }, dependencies, command.runId);
      try { plan = scratchpad.pendingBatch === undefined ? await dependencies.planner.plan({ rootUrl: root.href, scratchpad }) : { ok: true, value: scratchpad.pendingBatch.plan }; } catch (error) { return fail({ kind: "ExtractionPlannerFailed" }, dependencies, command.runId); }
      if (!plan.ok || !validPlan(plan.value) || plan.value.frontier.length > dependencies.policy.maximumFrontier) return fail({ kind: "ExtractionPlanInvalid" }, dependencies, command.runId);
      let currentPlan = freeze({ ...plan.value, frontier: freeze([...new Set([...persistedFrontier, ...plan.value.frontier])]) });
      scratchpad = cloneScratchpad({ ...scratchpad, discoveredUrls: [...new Set([...(scratchpad.discoveredUrls ?? []), ...currentPlan.frontier])] });
      const initialDiscoveredUrls = scratchpad.discoveredUrls ?? [];
      if (initialDiscoveredUrls.length > dependencies.policy.maximumFrontier) return fail({ kind: "ExtractionLimitExceeded", limit: "frontier" }, dependencies, command.runId);
      const planned = await remember(dependencies.memory, "decision", "source", { phase: "plan", revision: currentPlan.revision, decision: currentPlan.stopDecision.decision, rationale: currentPlan.stopDecision.rationale, frontier: currentPlan.frontier.slice(0, 50), discoveredUrls: initialDiscoveredUrls.slice(0, 50), unresolvedGaps: currentPlan.unresolvedGaps.slice(0, 50).map((gap) => ({ id: gap.id, priority: gap.priority, description: gap.description })) }, dependencies, command.runId);
      if (!planned.ok) return planned;
      const previouslyProcessedPages = scratchpad.processedUrls.length;
      let pagesProcessed = previouslyProcessedPages;
      while (true) {
        const observedMs = dependencies.nowMs();
        if (!Number.isFinite(observedMs) || observedMs < command.startedAtMs) throw new TypeError("Extraction clock returned an invalid instant.");
        if (observedMs >= command.deadlineAtMs) return { ok: true, value: freeze({ state: "awaiting-time-limit-decision", scratchpad: cloneScratchpad(scratchpad), knowledgePointCount: scratchpad.acceptedHashes.length, pagesProcessed, stopReason: "time-limit" }) };
        const nextUrl = scratchpad.pendingBatch?.observations[0]?.url ?? pendingFrontierUrl(currentPlan, scratchpad);
        if (nextUrl === null) {
          if (scratchpad.acceptedHashes.length === 0 && !((scratchpad.reviewedCandidateCount??0) > 0)) return fail({ kind: "KnowledgeSetEmpty" }, dependencies, command.runId);
          if (planIsComplete(currentPlan, scratchpad) || scratchpad.acceptedHashes.length === 0 && (scratchpad.reviewedCandidateCount ?? 0) > 0) {
            dependencies.logger({ event: "knowledge-extraction-success", runId: command.runId });
            return { ok: true, value: freeze({ state: "completed", scratchpad: cloneScratchpad(scratchpad), knowledgePointCount: scratchpad.acceptedHashes.length, pagesProcessed, stopReason: "agent-complete" }) };
          }
          if (currentPlan.stopDecision.decision === "blocked") {
            dependencies.logger({ event: "knowledge-extraction-agent-blocked", runId: command.runId });
            return { ok: true, value: freeze({ state: "completed", scratchpad: cloneScratchpad(scratchpad), knowledgePointCount: scratchpad.acceptedHashes.length, pagesProcessed, stopReason: "agent-blocked" }) };
          }
          return fail({ kind: "ExtractionCoverageIncomplete" }, dependencies, command.runId);
        }
        if (pagesProcessed >= dependencies.policy.maximumPages) return fail({ kind: "ExtractionLimitExceeded", limit: "pages" }, dependencies, command.runId);
        if (currentPlan.stopDecision.decision === "complete") return fail({ kind: "ExtractionCoverageIncomplete" }, dependencies, command.runId);
        if (currentPlan.stopDecision.decision === "blocked") {
          if (scratchpad.acceptedHashes.length === 0) return fail({ kind: "ExtractionStopped" }, dependencies, command.runId);
          dependencies.logger({ event: "knowledge-extraction-agent-blocked", runId: command.runId });
          return { ok: true, value: freeze({ state: "completed", scratchpad: cloneScratchpad(scratchpad), knowledgePointCount: scratchpad.acceptedHashes.length, pagesProcessed, stopReason: "agent-blocked" }) };
        }
        const destination = new URL(nextUrl);
        if (destination.origin !== root.origin || !withinPath(root, destination)) return fail({ kind: "UnsafeDestination" }, dependencies, command.runId);
        if (dependencies.checkRobots !== undefined) {
          let checked;
          try { checked = await dependencies.checkRobots(destination.href); } catch (error) { return fail({ kind: "ExtractionAcquisitionFailed", causeKind: "RobotsCheckFailed" }, dependencies, command.runId); }
          if (!checked.ok) return fail(acquisitionFailure(checked.error), dependencies, command.runId);
        }
        if (dependencies.batchAcquirer !== undefined && scratchpad.pendingBatch === undefined) {
          const urls = currentPlan.frontier.filter((url) => !scratchpad.processedUrls.includes(url)).slice(0, Math.min(dependencies.batchAcquirer.maximumBatchSize ?? 5, dependencies.policy.maximumPages - pagesProcessed));
          for (const url of urls) {
            if (new URL(url).origin !== root.origin || !withinPath(root, new URL(url))) return fail({ kind: "UnsafeDestination" }, dependencies, command.runId);
            if (dependencies.checkRobots !== undefined && url !== destination.href) {
              let checked;
              try { checked = await dependencies.checkRobots(url); } catch (error) { return fail({ kind: "ExtractionAcquisitionFailed", causeKind: "RobotsCheckFailed" }, dependencies, command.runId); }
              if (!checked.ok) return fail(acquisitionFailure(checked.error), dependencies, command.runId);
            }
          }
          let batch;
          try { batch = await dependencies.batchAcquirer.fetchBatch({ urls, rootUrl: root.href, plan: currentPlan, scratchpad }); } catch (error) { return fail({ kind: "ExtractionAcquisitionFailed" }, dependencies, command.runId); }
          if (!batch.ok) return fail(acquisitionFailure(batch.error), dependencies, command.runId);
          if (!Array.isArray(batch.value) || batch.value.length !== urls.length || batch.value.some((page, index) => !validObservation(page) || page.url !== urls[index] || page.candidates.some((candidate) => candidate.evidenceAnchors.some((anchor) => anchor.url !== page.url) || candidate.coverageGoalIds.some((id) => !currentPlan.coverageGoals.some((goal) => goal.id === id))))) return fail({ kind: "ExtractionObservationInvalid", field: "batch" }, dependencies, command.runId);
          if (batch.value.some((page) => page.byteCount > dependencies.policy.maximumPageBytes)) return fail({ kind: "ExtractionLimitExceeded", limit: "page-bytes" }, dependencies, command.runId);
          if (batch.value.some((page) => page.redirects > dependencies.policy.maximumRedirects)) return fail({ kind: "ExtractionLimitExceeded", limit: "redirects" }, dependencies, command.runId);
          scratchpad = cloneScratchpad({ ...scratchpad, pendingBatch: { key: dependencies.batchAcquirer.key, plan: currentPlan, observations: batch.value }, revision: scratchpad.revision + 1 });
          let checkpoint;
          try { checkpoint = await dependencies.scratchpad.save(scratchpad); } catch (error) { return fail({ kind: "ScratchpadPersistenceFailed" }, dependencies, command.runId); }
          if (!checkpoint.ok) return fail({ kind: "ScratchpadPersistenceFailed" }, dependencies, command.runId);
          dependencies.logger({ event: "knowledge-extraction-batch-checkpoint", runId: command.runId });
        }
        let acquired;
        try { acquired = scratchpad.pendingBatch === undefined ? await dependencies.acquirer.fetchPage({ url: destination.href, rootUrl: root.href, plan: currentPlan }) : { ok: true, value: scratchpad.pendingBatch.observations[0] }; } catch (error) { return fail({ kind: "ExtractionAcquisitionFailed" }, dependencies, command.runId); }
        if (!acquired.ok) return fail(acquisitionFailure(acquired.error), dependencies, command.runId);
        const observation = acquired.value;
        if (!validObservation(observation)) return fail({ kind: "ExtractionObservationInvalid", field: "observation" }, dependencies, command.runId);
        if (observation.url !== destination.href || new URL(observation.url).origin !== root.origin || !withinPath(root, new URL(observation.url))) return fail({ kind: "UnsafeDestination" }, dependencies, command.runId);
        if(observation.responseUrl!==undefined&&(new URL(observation.responseUrl).origin!==root.origin||!withinPath(root,new URL(observation.responseUrl))))return fail({kind:"UnsafeDestination"},dependencies,command.runId);
        if (observation.candidates.some((candidate) => candidate.evidenceAnchors.some((anchor) => anchor.url !== (observation.responseUrl??observation.url)))) return fail({ kind: "ExtractionObservationInvalid", field: "evidenceAnchors" }, dependencies, command.runId);
        const coverageGoalIds = new Set(currentPlan.coverageGoals.map((goal) => goal.id));
        if(observation.responseUrl!==undefined&&(new URL(observation.responseUrl).origin!==root.origin||!withinPath(root,new URL(observation.responseUrl))))return fail({kind:"UnsafeDestination"},dependencies,command.runId);
        if (observation.candidates.some((candidate) => candidate.coverageGoalIds.some((goalId) => !coverageGoalIds.has(goalId)))) return fail({ kind: "ExtractionObservationInvalid", field: "coverageGoalIds" }, dependencies, command.runId);
        if (observation.byteCount > dependencies.policy.maximumPageBytes) return fail({ kind: "ExtractionLimitExceeded", limit: "page-bytes" }, dependencies, command.runId);
        if (observation.redirects > dependencies.policy.maximumRedirects) return fail({ kind: "ExtractionLimitExceeded", limit: "redirects" }, dependencies, command.runId);
        const pageNote = freeze({ url: observation.url, title: observation.title, note: (text(observation.notes) ? observation.notes : `Observed ${observation.candidates.length} candidate knowledge points and ${observation.links.length} same-origin links.`).slice(0, 2_000), observedAt: observation.observedAt, linkCount: observation.links.length, candidateCount: observation.candidates.length });
        const pageMemory = await remember(dependencies.memory, "durable-fact", "source", { phase: "page-observed", url: observation.url, title: observation.title, note: pageNote.note, observedAt: observation.observedAt, byteCount: observation.byteCount, redirects: observation.redirects, links: observation.links.slice(0, 50), candidateCount: observation.candidates.length }, dependencies, command.runId);
        if (!pageMemory.ok) return pageMemory;
        let novel = 0;
        for (const candidate of observation.candidates) {
          if (dependencies.reviewer === undefined && scratchpad.acceptedHashes.includes(candidate.normalizedHash)) continue;
          if (dependencies.reviewer === undefined && candidate.similarity?.decision === "ambiguous") return fail({ kind: "KnowledgeDuplicateAmbiguous" }, dependencies, command.runId);
          if (candidate.similarity !== undefined) scratchpad = cloneScratchpad({ ...scratchpad, similarityEvidence: [...scratchpad.similarityEvidence, { candidateHash: candidate.normalizedHash, comparedLocalHash: candidate.similarity.comparedLocalHash, score: candidate.similarity.score, decision: candidate.similarity.decision }] });
          if (dependencies.reviewer === undefined && candidate.similarity?.decision === "merge") continue;
          let point = /** @type {KnowledgePoint} */ (freeze({ id: `knowledge:${command.sourceId}:${command.sourceRevision}:${candidate.normalizedHash}`, sourceId: command.sourceId, sourceRevision: command.sourceRevision, summary: candidate.summary, normalizedHash: candidate.normalizedHash, evidenceAnchors: freeze(candidate.evidenceAnchors.map((anchor) => freeze({ ...anchor }))), coverageGoalIds: freeze([...candidate.coverageGoalIds]), mediaCandidates: freeze([...candidate.mediaCandidates]), attribution: freeze({ sourceUrl: observation.responseUrl??observation.url }), extractionVersion }));
          if (dependencies.reviewer !== undefined) {
            let reviewed;
            try { reviewed = await dependencies.reviewer.review(point, observation); } catch (error) { return fail({ kind: "KnowledgePersistenceFailed", causeKind: "KnowledgeReviewFailed" }, dependencies, command.runId); }
            if (!reviewed.ok) return fail({kind:"KnowledgePersistenceFailed",causeKind:reviewed.error.kind},dependencies,command.runId);
            scratchpad = cloneScratchpad({...scratchpad,reviewedCandidateCount:(scratchpad.reviewedCandidateCount??0)+1});
            if (reviewed.value === null) continue;
            point = reviewed.value;
            if (!validCandidate({summary:point.summary,normalizedHash:point.normalizedHash,evidenceAnchors:point.evidenceAnchors,coverageGoalIds:point.coverageGoalIds,mediaCandidates:point.mediaCandidates}) || point.sourceId !== command.sourceId || point.sourceRevision !== command.sourceRevision || point.evidenceAnchors.some(anchor=>!candidate.evidenceAnchors.some(original=>original.url===anchor.url&&original.selector===anchor.selector&&original.blockId===anchor.blockId&&original.quoteDigest===anchor.quoteDigest&&original.quote===anchor.quote)) || point.coverageGoalIds.some(id=>!candidate.coverageGoalIds.includes(id)) || point.attribution.sourceUrl !== (observation.responseUrl??observation.url)) return fail({kind:"KnowledgePersistenceFailed",causeKind:"KnowledgeReviewOutputInvalid"},dependencies,command.runId);
          }
          let appended;
          try { appended = await dependencies.knowledge.append(point); } catch (error) { const causeKind = isRecord(error) && text(error.kind) ? error.kind : "KnowledgeRepositoryRejected"; return fail({ kind: "KnowledgePersistenceFailed", causeKind }, dependencies, command.runId); }
          if (!appended.ok) { const causeKind = isRecord(appended.error) && text(appended.error.kind) ? appended.error.kind : undefined; return fail({ kind: "KnowledgePersistenceFailed", ...(causeKind === undefined || causeKind === "KnowledgePersistenceFailed" ? {} : { causeKind }) }, dependencies, command.runId); }
          const acceptedMemory = await remember(dependencies.memory, "durable-fact", "source", { phase: "knowledge-accepted", knowledgeId: point.id, normalizedHash: point.normalizedHash, evidenceDigests: point.evidenceAnchors.flatMap((anchor) => anchor.quoteDigest === undefined ? [] : [anchor.quoteDigest]).slice(0, 50), coverageGoalIds: point.coverageGoalIds.slice(0, 50), sourceUrl: observation.url }, dependencies, command.runId);
          if (!acceptedMemory.ok) return acceptedMemory;
          scratchpad = cloneScratchpad({ ...scratchpad, acceptedHashes: [...new Set([...scratchpad.acceptedHashes, point.normalizedHash])], coverage: [...new Set([...scratchpad.coverage, ...point.coverageGoalIds])] });
          novel += 1;
        }
        const nextZero = novel === 0 ? scratchpad.consecutiveNoveltyZero + 1 : 0;
        const scopedLinks = observation.links.filter((link) => {
          const candidate = new URL(link);
          return candidate.origin === root.origin && withinPath(root, candidate);
        });
        const discoveredUrls = [...new Set([...(scratchpad.discoveredUrls ?? []), ...currentPlan.frontier, ...scopedLinks])];
        if (discoveredUrls.length > dependencies.policy.maximumFrontier) return fail({ kind: "ExtractionLimitExceeded", limit: "frontier" }, dependencies, command.runId);
        scratchpad = cloneScratchpad({ ...scratchpad, processedUrls: [...scratchpad.processedUrls, observation.url], frontier: [...new Set([...currentPlan.frontier, ...observation.links])], discoveredUrls, unresolvedGaps: currentPlan.unresolvedGaps, consecutiveNoveltyZero: nextZero, pageNotes: [...(scratchpad.pageNotes ?? []), pageNote].slice(-100), revision: scratchpad.revision + 1 });
        if (scratchpad.pendingBatch !== undefined) {
          const remaining = scratchpad.pendingBatch.observations.slice(1);
          const { pendingBatch, ...progress } = scratchpad;
          scratchpad = cloneScratchpad({ ...progress, ...(remaining.length === 0 ? {} : { pendingBatch: { ...pendingBatch, observations: remaining } }) });
        }
        let saved;
        try { saved = await dependencies.scratchpad.save(scratchpad); } catch (error) { return fail({ kind: "ScratchpadPersistenceFailed" }, dependencies, command.runId); }
        if (!saved.ok) return fail({ kind: "ScratchpadPersistenceFailed" }, dependencies, command.runId);
        pagesProcessed += 1;
        if (dependencies.stopRequested?.() === true) return { ok: true, value: freeze({ state: "paused", scratchpad: cloneScratchpad(scratchpad), knowledgePointCount: scratchpad.acceptedHashes.length, pagesProcessed, stopReason: "paused" }) };
        if (scratchpad.pendingBatch !== undefined) {
          if (dependencies.policy.maximumPagesPerExecution !== undefined && pagesProcessed - previouslyProcessedPages >= dependencies.policy.maximumPagesPerExecution) return { ok: true, value: freeze({ state: "awaiting-time-limit-decision", scratchpad, knowledgePointCount: scratchpad.acceptedHashes.length, pagesProcessed, stopReason: "paused" }) };
          continue;
        }
        let replanned;
        try { replanned = await dependencies.planner.replan({ previous: currentPlan, observation, scratchpad }); } catch (error) { return fail({ kind: "ExtractionPlannerFailed" }, dependencies, command.runId); }
        if (!replanned.ok || !validPlan(replanned.value) || replanned.value.frontier.length > dependencies.policy.maximumFrontier) return fail({ kind: "ExtractionPlanInvalid" }, dependencies, command.runId);
        const proposedPlan = replanned.value;
        const coverageGoals = new Map(currentPlan.coverageGoals.map((goal) => [goal.id, goal]));
        for (const goal of proposedPlan.coverageGoals) coverageGoals.set(goal.id, goal);
        const preservedFrontier = [...new Set([...proposedPlan.frontier, ...(scratchpad.discoveredUrls ?? [])])].filter((url) => !scratchpad.processedUrls.includes(url));
        if (preservedFrontier.length > dependencies.policy.maximumFrontier) return fail({ kind: "ExtractionLimitExceeded", limit: "frontier" }, dependencies, command.runId);
        currentPlan = freeze({ ...proposedPlan, coverageGoals: freeze([...coverageGoals.values()]), frontier: freeze(preservedFrontier) });
        const prematureComplete = currentPlan.stopDecision.decision === "complete" && pendingFrontierUrl(currentPlan, scratchpad) !== null;
        if (prematureComplete) {
          dependencies.logger({ event: "knowledge-extraction-premature-complete-rejected", runId: command.runId, failureKind: "ExtractionCoverageIncomplete" });
          currentPlan = freeze({ ...currentPlan, stopDecision: freeze({ ...currentPlan.stopDecision, decision: "continue", rationale: "Deterministic verification found relevant discovered pages that have not been observed." }) });
        }
        const replannedMemory = await remember(dependencies.memory, "decision", "source", { phase: "replan", revision: currentPlan.revision, afterUrl: observation.url, proposedDecision: proposedPlan.stopDecision.decision, decision: currentPlan.stopDecision.decision, rationale: currentPlan.stopDecision.rationale, frontier: currentPlan.frontier.slice(0, 50), discoveredUrls: scratchpad.discoveredUrls?.slice(0, 50) ?? [], unresolvedGaps: currentPlan.unresolvedGaps.slice(0, 50).map((gap) => ({ id: gap.id, priority: gap.priority, description: gap.description })) }, dependencies, command.runId);
        if (!replannedMemory.ok) return replannedMemory;
        for (const gap of currentPlan.unresolvedGaps.slice(0, 50)) {
          const unresolvedMemory = await remember(dependencies.memory, "unresolved", "source", { phase: "replan", gap: { id: gap.id, priority: gap.priority, description: gap.description }, afterUrl: observation.url }, dependencies, command.runId);
          if (!unresolvedMemory.ok) return unresolvedMemory;
        }
        if (currentPlan.stopDecision.decision === "complete") {
          if (pendingFrontierUrl(currentPlan, scratchpad) !== null || (!(scratchpad.acceptedHashes.length === 0 && (scratchpad.reviewedCandidateCount??0) > 0) && (!coverageComplete(currentPlan, scratchpad) || currentPlan.unresolvedGaps.some((gap) => gap.priority === "high")))) return fail({ kind: "ExtractionCoverageIncomplete" }, dependencies, command.runId);
          if (scratchpad.acceptedHashes.length === 0 && !((scratchpad.reviewedCandidateCount??0) > 0)) return fail({ kind: "KnowledgeSetEmpty" }, dependencies, command.runId);
          dependencies.logger({ event: "knowledge-extraction-success", runId: command.runId });
          return { ok: true, value: freeze({ state: "completed", scratchpad: cloneScratchpad(scratchpad), knowledgePointCount: scratchpad.acceptedHashes.length, pagesProcessed, stopReason: "agent-complete" }) };
        }
        if (currentPlan.stopDecision.decision === "blocked") {
          if (scratchpad.acceptedHashes.length === 0) return fail({ kind: "ExtractionStopped" }, dependencies, command.runId);
          dependencies.logger({ event: "knowledge-extraction-agent-blocked", runId: command.runId });
          return { ok: true, value: freeze({ state: "completed", scratchpad: cloneScratchpad(scratchpad), knowledgePointCount: scratchpad.acceptedHashes.length, pagesProcessed, stopReason: "agent-blocked" }) };
        }
        if (dependencies.policy.maximumPagesPerExecution !== undefined) {
          scratchpad = cloneScratchpad({ ...scratchpad, frontier: currentPlan.frontier, discoveredUrls: [...new Set([...(scratchpad.discoveredUrls ?? []), ...currentPlan.frontier])], unresolvedGaps: currentPlan.unresolvedGaps, revision: scratchpad.revision + 1 });
          let replannedSaved;
          try { replannedSaved = await dependencies.scratchpad.save(scratchpad); } catch (error) { return fail({ kind: "ScratchpadPersistenceFailed" }, dependencies, command.runId); }
          if (!replannedSaved.ok) return fail({ kind: "ScratchpadPersistenceFailed" }, dependencies, command.runId);
          if (pagesProcessed - previouslyProcessedPages >= dependencies.policy.maximumPagesPerExecution) {
            dependencies.logger({ event: "knowledge-extraction-chunk-yield", runId: command.runId });
            return { ok: true, value: freeze({ state: "awaiting-time-limit-decision", scratchpad: cloneScratchpad(scratchpad), knowledgePointCount: scratchpad.acceptedHashes.length, pagesProcessed, stopReason: "paused" }) };
          }
        }
      }
    },
  });
}

/** @param {URL} root @param {URL} candidate @returns {boolean} */
function withinPath(root, candidate) {
  if (root.pathname === "/") return true;
  const rootPath = root.pathname.endsWith("/") ? root.pathname.slice(0, -1) : root.pathname;
  const candidatePath = candidate.pathname.endsWith("/") && candidate.pathname !== "/" ? candidate.pathname.slice(0, -1) : candidate.pathname;
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}

/** @param {ExtractionPlan} plan @param {ExtractionScratchpad} scratchpad @returns {boolean} */
function coverageComplete(plan, scratchpad) {
  return plan.coverageGoals.every((goal) => scratchpad.coverage.includes(goal.id));
}

export { validCandidate as isKnowledgeCandidate, validPlan as isExtractionPlan, validVisualMediaReference as isVisualMediaReference };
