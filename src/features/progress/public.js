// @ts-check
import { SUBJECTS, isSubjectId } from "../knowledge-subjects/public.js";

/** @typedef {{readonly batchId:string,readonly questionId:string,readonly knowledgeId:string|null,readonly answeredAt:string,readonly correct:boolean,readonly score:number|null,readonly elapsedDays:number|null,readonly previousCorrect:boolean|null,readonly primarySubject:string|null}} ProgressAttempt */
/** @typedef {{readonly completedAt:string,readonly itemCount:number}} ProgressStudy */
/** @typedef {{readonly kind:"ProgressInputInvalid",readonly field:string}} ProgressInputInvalid */
/** @template T @typedef {{readonly ok:true,readonly value:T}|{readonly ok:false,readonly error:ProgressInputInvalid}} Result */
/** @typedef {{readonly period:{readonly days:number,readonly startedOn:string,readonly endedOn:string,readonly subject:string|null},readonly attempts:{readonly count:number,readonly correct:number,readonly accuracy:number|null,readonly scoredCount:number,readonly averageScore:number|null},readonly daily:readonly {readonly date:string,readonly count:number,readonly correct:number,readonly accuracy:number|null}[],readonly intervals:readonly {readonly label:string,readonly count:number,readonly correct:number,readonly accuracy:number|null}[],readonly subjects:readonly {readonly id:string,readonly label:string,readonly count:number,readonly correct:number,readonly accuracy:number|null}[],readonly recovery:{readonly eligible:number,readonly recovered:number,readonly accuracy:number|null},readonly activity:readonly {readonly date:string,readonly studyBatches:number,readonly studyItems:number,readonly reviewAttempts:number}[]}} ProgressSummary */

const freeze = Object.freeze;
const daysAllowed = new Set([7, 30, 90]);
/** @param {number} correct @param {number} count */
const fraction = (correct, count) => count === 0 ? null : correct / count;
/** @param {unknown} value */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = value => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} value */
const iso = value => typeof value === "string" && Number.isFinite(Date.parse(value));
/** @param {unknown} value */
const identifier = value => typeof value === "string" && value.trim() === value && value.length > 0;
/** @param {string} value */
const day = value => new Date(value).toISOString().slice(0, 10);
/** @param {string} value */
function utcDays(value) { const d = new Date(value); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
/** @param {unknown} input @returns {Result<ProgressSummary>} */
export function buildProgress(input) {
  /** @param {string} field @returns {Result<never>} */
  const fail = field => ({ ok: false, error: freeze({ kind: "ProgressInputInvalid", field }) });
  if (!isRecord(input) || Object.keys(input).sort().join(",") !== "attempts,days,now,studies,subject") return fail("shape");
  const value = /** @type {Record<string,unknown>} */ (input);
  if (!daysAllowed.has(/** @type {number} */(value.days))) return fail("days");
  if (!iso(value.now)) return fail("now");
  if (value.subject !== null && !isSubjectId(value.subject)) return fail("subject");
  if (!Array.isArray(value.attempts)) return fail("attempts");
  if (!Array.isArray(value.studies)) return fail("studies");
  /** @type {ProgressAttempt[]} */ const attempts = [];
  const seen = new Map();
  for (let index = 0; index < value.attempts.length; index++) {
    const item = value.attempts[index];
    if (!isRecord(item) || Object.keys(item).sort().join(",") !== "answeredAt,batchId,correct,elapsedDays,knowledgeId,previousCorrect,primarySubject,questionId,score") return fail(`attempts.${index}`);
    const a = /** @type {Record<string,unknown>} */(item);
    // Historical partial-credit attempts can remain incorrect above the new 70% cutoff.
    if (!identifier(a.batchId) || !identifier(a.questionId) || (a.knowledgeId !== null && !identifier(a.knowledgeId)) || !iso(a.answeredAt) || typeof a.correct !== "boolean" || (a.score !== null && (typeof a.score !== "number" || !Number.isFinite(a.score) || a.score < 0 || a.score > 1 || (a.correct ? a.score < 0.7 : a.score === 1))) || (a.elapsedDays !== null && (typeof a.elapsedDays !== "number" || !Number.isFinite(a.elapsedDays) || a.elapsedDays < 0)) || (a.previousCorrect !== null && typeof a.previousCorrect !== "boolean") || (a.primarySubject !== null && !isSubjectId(a.primarySubject))) return fail(`attempts.${index}`);
    const attempt = /** @type {ProgressAttempt} */(freeze({ ...a }));
    const key = JSON.stringify([attempt.batchId, attempt.questionId]);
    const prior = seen.get(key); const serialized = JSON.stringify([attempt.batchId,attempt.questionId,attempt.knowledgeId,attempt.answeredAt,attempt.correct,attempt.score,attempt.elapsedDays,attempt.previousCorrect,attempt.primarySubject]);
    if (prior !== undefined) { if (prior !== serialized) return fail(`attempts.${index}.duplicate`); continue; }
    seen.set(key, serialized); attempts.push(attempt);
  }
  /** @type {ProgressStudy[]} */ const studies = [];
  for (let index = 0; index < value.studies.length; index++) {
    const item = value.studies[index];
    if (!isRecord(item) || Object.keys(item).sort().join(",") !== "completedAt,itemCount" || !iso(item.completedAt) || typeof item.itemCount !== "number" || !Number.isInteger(item.itemCount) || item.itemCount < 1 || item.itemCount > 5) return fail(`studies.${index}`);
    studies.push(freeze({ completedAt: /** @type {string} */(item.completedAt), itemCount: /** @type {number} */(item.itemCount) }));
  }
  const now = /** @type {string} */(value.now), end = day(now), startMs = utcDays(now) - (/** @type {number} */(value.days) - 1) * 86_400_000;
  const dates = Array.from({ length: /** @type {number} */(value.days) }, (_, i) => new Date(startMs + i * 86_400_000).toISOString().slice(0, 10));
  const inPeriod = /** @param {string} date */ (date) => { const ms = utcDays(date); return ms >= startMs && ms <= utcDays(now) && Date.parse(date) <= Date.parse(now); };
  const filtered = attempts.filter(a => inPeriod(a.answeredAt) && (value.subject === null || a.primarySubject === value.subject));
  const daily = dates.map(date => ({ date, ...stat(filtered.filter(a => day(a.answeredAt) === date)) }));
  /** @type {[string,(a:ProgressAttempt)=>boolean][]} */ const intervalDefs = [["Under 1 day", a => a.elapsedDays !== null && a.elapsedDays < 1], ["1–7 days", a => a.elapsedDays !== null && a.elapsedDays >= 1 && a.elapsedDays < 7], ["7–30 days", a => a.elapsedDays !== null && a.elapsedDays >= 7 && a.elapsedDays < 30], ["30+ days", a => a.elapsedDays !== null && a.elapsedDays >= 30], ["Unavailable", a => a.elapsedDays === null]];
  const intervals = intervalDefs.map(([label, match]) => metric(/** @type {string} */(label), filtered.filter(/** @type {(a:ProgressAttempt)=>boolean} */(match))));
  const subjectRows = [...SUBJECTS.filter(s => value.subject === null || s.id === value.subject).map(s => ({ id: s.id, label: s.label, ...stat(filtered.filter(a => a.primarySubject === s.id)) })), ...(value.subject === null ? [{ id: "unclassified", label: "Unclassified", ...stat(filtered.filter(a => a.primarySubject === null)) }] : [])];
  const eligible = filtered.filter(a => a.previousCorrect === false && a.elapsedDays !== null && a.elapsedDays >= 1);
  const activity = dates.map(date => { const complete = studies.filter(s => inPeriod(s.completedAt) && day(s.completedAt) === date); return freeze({ date, studyBatches: complete.length, studyItems: complete.reduce((total, s) => total + s.itemCount, 0), reviewAttempts: filtered.filter(a => day(a.answeredAt) === date).length }); });
  return { ok: true, value: freeze({ period: freeze({ days: /** @type {number} */(value.days), startedOn: dates[0], endedOn: end, subject: /** @type {string|null} */(value.subject) }), attempts: freeze(counts(filtered)), daily: freeze(daily), intervals: freeze(intervals), subjects: freeze(subjectRows), recovery: freeze({ eligible: eligible.length, recovered: eligible.filter(a => a.correct).length, accuracy: fraction(eligible.filter(a => a.correct).length, eligible.length) }), activity: freeze(activity) }) };
}
/** @param {ProgressAttempt[]} rows */
function stat(rows) { const correct = rows.filter(a => a.correct).length; return { count: rows.length, correct, accuracy: fraction(correct, rows.length) }; }
/** @param {ProgressAttempt[]} rows */
function counts(rows) { const { count, correct, accuracy } = stat(rows), scores = rows.filter(a => a.score !== null).map(a => /** @type {number} */(a.score)); return { count, correct, accuracy, scoredCount: scores.length, averageScore: scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length }; }
/** @param {string} label @param {ProgressAttempt[]} rows */
function metric(label, rows) { return freeze({ label, ...stat(rows) }); }
/** @param {unknown} value @returns {value is ProgressSummary} */
export function isProgressSummary(value) {
  if (!isRecord(value) || !isRecord(value.period) || typeof value.period.days !== "number" || !daysAllowed.has(value.period.days) || !dayOnly(value.period.startedOn) || !dayOnly(value.period.endedOn) || (value.period.subject !== null && !isSubjectId(value.period.subject)) || !isRecord(value.attempts) || !isCounts(value.attempts, true) || !Array.isArray(value.daily) || value.daily.length !== value.period.days || !Array.isArray(value.intervals) || value.intervals.length !== 5 || !Array.isArray(value.subjects) || !isRecord(value.recovery) || !Array.isArray(value.activity) || value.activity.length !== value.period.days) return false;
  return value.daily.every(row => isRecord(row) && dayOnly(row.date) && isCounts(row)) && value.intervals.every(row => isRecord(row) && typeof row.label === "string" && isCounts(row)) && value.subjects.every(row => isRecord(row) && (row.id === "unclassified" || isSubjectId(row.id)) && typeof row.label === "string" && isCounts(row)) && typeof value.recovery.eligible === "number" && typeof value.recovery.recovered === "number" && Number.isInteger(value.recovery.eligible) && Number.isInteger(value.recovery.recovered) && value.recovery.eligible >= 0 && value.recovery.recovered >= 0 && value.recovery.recovered <= value.recovery.eligible && ratio(value.recovery.accuracy) && value.recovery.accuracy === fraction(value.recovery.recovered, value.recovery.eligible) && value.activity.every(row => isRecord(row) && dayOnly(row.date) && [row.studyBatches, row.studyItems, row.reviewAttempts].every(n => typeof n === "number" && Number.isInteger(n) && n >= 0));
}
/** @param {Record<string,unknown>} value @param {boolean} [scores] */
function isCounts(value, scores = false) { return typeof value.count === "number" && Number.isInteger(value.count) && value.count >= 0 && typeof value.correct === "number" && Number.isInteger(value.correct) && value.correct >= 0 && value.correct <= value.count && ratio(value.accuracy) && value.accuracy === fraction(value.correct, value.count) && (!scores || typeof value.scoredCount === "number" && Number.isInteger(value.scoredCount) && value.scoredCount >= 0 && value.scoredCount <= value.count && (value.scoredCount === 0 ? value.averageScore === null : typeof value.averageScore === "number" && Number.isFinite(value.averageScore) && value.averageScore >= 0 && value.averageScore <= 1)); }
/** @param {unknown} value */
function ratio(value) { return value === null || typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
/** @param {unknown} value */
function dayOnly(value) { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0,10) === value; }
