// @ts-check
import { parseClassification, isSubjectId } from "../src/features/knowledge-subjects/public.js";
import { buildProgress } from "../src/features/progress/public.js";
/** @import { D1DatabasePort, LearnerBatchLog } from "./learning-batches-d1.js" */
/** @typedef {"ProgressCommandInvalid"|"ProgressDataInvalid"|"ProgressReadUnavailable"|"ProgressHistoryLimitExceeded"|"ClassificationCommandInvalid"|"ClassificationConflict"|"ClassificationWriteUnavailable"} FailureKind */
/** @template T @typedef {{readonly ok:true,readonly value:T}|{readonly ok:false,readonly error:{readonly kind:FailureKind}}} Result */
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim().length > 0 && value.length <= 512; }

/** @param {{database:D1DatabasePort,now:()=>string,logger:(event:LearnerBatchLog)=>void}} dependencies */
export function createLearningProgressService({ database, now, logger }) {
  if (typeof database?.prepare !== "function" || typeof now !== "function" || typeof logger !== "function") throw new TypeError("ProgressDependenciesInvalid");
  /** @param {string} ownerId @param {number} days @param {string|null} subject @returns {Promise<Result<unknown>>} */
  async function loadProgress(ownerId, days, subject) {
    logger({ event: "learning-progress-entry" });
    /** @param {FailureKind} kind @returns {Result<never>} */
    const fail = kind => { logger({ event: "learning-progress-failure", failureKind: kind }); return { ok: false, error: { kind } }; };
    if (!text(ownerId) || ![7, 30, 90].includes(days) || (subject !== null && !isSubjectId(subject))) return fail("ProgressCommandInvalid");
    const timestamp = now();
    if (!Number.isFinite(Date.parse(timestamp))) return fail("ProgressDataInvalid");
    const start = new Date(timestamp); start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() - days + 1);
    try {
      const answers = await database.prepare("SELECT a.batch_id, a.question_id, COALESCE(a.knowledge_id, t.item_id) AS knowledge_id, a.answered_at, a.correct, a.score, a.elapsed_days, a.previous_correct, p.point_json, c.classification_json FROM learner_review_answers a LEFT JOIN learning_generation_tasks t ON t.owner_id = a.owner_id AND t.task_id = a.question_id LEFT JOIN extraction_knowledge_points p ON p.owner_id = a.owner_id AND p.knowledge_id = COALESCE(a.knowledge_id, t.item_id) LEFT JOIN knowledge_classifications c ON c.owner_id = a.owner_id AND c.knowledge_id = p.knowledge_id WHERE a.owner_id = ? AND a.answered_at >= ? AND a.answered_at <= ? ORDER BY a.answered_at, a.batch_id, a.question_id LIMIT 10001").bind(ownerId, start.toISOString(), timestamp).all();
      const study = await database.prepare("SELECT completed_at, json_array_length(item_ids_json) AS item_count FROM learner_feed_batches WHERE owner_id = ? AND status = 'completed' AND completed_at >= ? AND completed_at <= ? ORDER BY completed_at LIMIT 10001").bind(ownerId, start.toISOString(), timestamp).all();
      const subjects = await database.prepare("SELECT CASE WHEN c.classification_json IS NOT NULL THEN json_extract(c.classification_json, '$.primarySubject') ELSE json_extract(p.point_json, '$.classification.primarySubject') END AS id, COUNT(*) AS count FROM extraction_knowledge_points p JOIN library_sources s ON s.owner_id = p.owner_id AND s.source_id = p.source_id AND s.state = 'active' AND s.revision = p.source_revision LEFT JOIN knowledge_classifications c ON c.owner_id = p.owner_id AND c.knowledge_id = p.knowledge_id WHERE p.owner_id = ? GROUP BY id HAVING id IS NOT NULL").bind(ownerId).all();
      if (!answers.success || !study.success || !subjects.success) return fail("ProgressReadUnavailable");
      if (answers.results.length > 10000 || study.results.length > 10000) return fail("ProgressHistoryLimitExceeded");
      const attempts = [];
      for (const row of answers.results) {
        if (!record(row) || (row.correct !== 0 && row.correct !== 1) || (row.previous_correct !== null && row.previous_correct !== 0 && row.previous_correct !== 1)) return fail("ProgressDataInvalid");
        let classification = null;
        if (row.classification_json !== null) {
          if (typeof row.classification_json !== "string") return fail("ProgressDataInvalid");
          classification = JSON.parse(row.classification_json);
        } else if (row.point_json !== null) {
          if (typeof row.point_json !== "string") return fail("ProgressDataInvalid");
          const point = JSON.parse(row.point_json);
          if (!record(point)) return fail("ProgressDataInvalid");
          if (Object.hasOwn(point, "classification")) classification = point.classification;
        }
        let primarySubject = null;
        if (classification !== null) {
          const parsed = parseClassification(classification);
          if (!parsed.ok) return fail("ProgressDataInvalid");
          primarySubject = parsed.value.primarySubject;
        }
        attempts.push({ batchId: row.batch_id, questionId: row.question_id, knowledgeId: row.knowledge_id, answeredAt: row.answered_at, correct: row.correct === 1, score: row.score, elapsedDays: row.elapsed_days, previousCorrect: row.previous_correct === null ? null : row.previous_correct === 1, primarySubject });
      }
      const studies = [];
      for (const row of study.results) {
        if (!record(row)) return fail("ProgressDataInvalid");
        studies.push({ completedAt: row.completed_at, itemCount: row.item_count });
      }
      const result = buildProgress({ days, now: timestamp, subject, attempts, studies, subjectCounts: subjects.results });
      if (!result.ok) return fail("ProgressDataInvalid");
      logger({ event: "learning-progress-success", itemCount: attempts.length });
      return { ok: true, value: result.value };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return fail(error instanceof SyntaxError ? "ProgressDataInvalid" : "ProgressReadUnavailable");
    }
  }

  /** @param {unknown} command @returns {Promise<Result<unknown>>} */
  async function correctClassification(command) {
    logger({ event: "knowledge-classification-entry" });
    /** @param {FailureKind} kind @returns {Result<never>} */
    const fail = kind => { logger({ event: "knowledge-classification-failure", failureKind: kind }); return { ok: false, error: { kind } }; };
    if (!record(command) || Object.keys(command).sort().join(",") !== "classification,expectedRevision,knowledgeId,ownerId" || !text(command.ownerId) || !text(command.knowledgeId) || typeof command.expectedRevision !== "number" || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) return fail("ClassificationCommandInvalid");
    const parsed = parseClassification(command.classification);
    if (!parsed.ok) return fail("ClassificationCommandInvalid");
    const timestamp = now();
    if (!Number.isFinite(Date.parse(timestamp))) return fail("ClassificationWriteUnavailable");
    try {
      const revision = command.expectedRevision + 1;
      const written = command.expectedRevision === 0
        ? await database.prepare("INSERT INTO knowledge_classifications (owner_id, knowledge_id, classification_json, revision, updated_at) SELECT ?, ?, ?, 1, ? WHERE EXISTS (SELECT 1 FROM extraction_knowledge_points WHERE owner_id = ? AND knowledge_id = ?) ON CONFLICT(owner_id, knowledge_id) DO NOTHING").bind(command.ownerId, command.knowledgeId, JSON.stringify(parsed.value), timestamp, command.ownerId, command.knowledgeId).run()
        : await database.prepare("UPDATE knowledge_classifications SET classification_json = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND knowledge_id = ? AND revision = ?").bind(JSON.stringify(parsed.value), timestamp, command.ownerId, command.knowledgeId, command.expectedRevision).run();
      if (!written.success) return fail("ClassificationWriteUnavailable");
      if (written.meta?.changes !== 1) return fail("ClassificationConflict");
      logger({ event: "knowledge-classification-success" });
      return { ok: true, value: { classification: parsed.value, classificationRevision: revision } };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return fail("ClassificationWriteUnavailable");
    }
  }
  return Object.freeze({ loadProgress, correctClassification });
}
