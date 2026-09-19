// @ts-check
// User-approved closed taxonomy v1. Changing IDs requires a versioned migration.
export const SUBJECTS = Object.freeze([
  ["mathematics", "Mathematics & Statistics"], ["computing", "Computer Science & AI"],
  ["physics", "Physics & Astronomy"], ["chemistry", "Chemistry"],
  ["biology", "Biology & Life Sciences"], ["earth", "Earth Science & Environment"],
  ["geography", "Geography"], ["engineering", "Engineering & Technology"],
  ["health", "Medicine & Health"], ["psychology", "Psychology & Cognitive Science"],
  ["sports", "Sports & Movement"], ["history", "History & Archaeology"],
  ["politics", "Politics & Law"], ["society", "Sociology & Anthropology"],
  ["economics", "Economics & Finance"], ["business", "Business & Management"],
  ["languages", "Languages & Linguistics"], ["literature", "Literature & Writing"],
  ["philosophy", "Philosophy, Ethics & Religion"], ["arts", "Visual Arts, Design & Film"],
  ["music", "Music & Performing Arts"], ["life-skills", "Practical Life Skills"],
].map(([id, label]) => Object.freeze({ id, label })));

/** @typedef {{readonly version: 1, readonly primarySubject: string | null, readonly secondarySubjects: readonly string[], readonly subcategory: string | null}} Classification */
/** @typedef {{readonly kind: "ClassificationInvalid", readonly field: string}} ClassificationFailure */
/** @template T @typedef {{readonly ok:true, readonly value:T}|{readonly ok:false, readonly error:ClassificationFailure}} ClassificationResult */
/** @param {unknown} value @returns {value is string} */
export function isSubjectId(value) { return typeof value === "string" && SUBJECTS.some(subject => subject.id === value); }

/** Strict boundary for model output, persisted metadata, and manual corrections.
 * Missing legacy metadata is handled explicitly by callers, never by this parser.
 * @param {unknown} value @returns {ClassificationResult<Classification>}
 */
export function parseClassification(value) {
  /** @param {string} field @returns {ClassificationResult<never>} */
  const fail = field => ({ ok: false, error: { kind: "ClassificationInvalid", field } });
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("shape");
  const item = /** @type {Record<string, unknown>} */ (value);
  if (Object.keys(item).sort().join(",") !== "primarySubject,secondarySubjects,subcategory,version" || item.version !== 1) return fail("version");
  if (item.primarySubject !== null && !isSubjectId(item.primarySubject)) return fail("primarySubject");
  if (!Array.isArray(item.secondarySubjects) || item.secondarySubjects.length > 2 || !item.secondarySubjects.every(isSubjectId) || new Set(item.secondarySubjects).size !== item.secondarySubjects.length || (item.primarySubject !== null && item.secondarySubjects.includes(item.primarySubject))) return fail("secondarySubjects");
  if (item.subcategory !== null && (typeof item.subcategory !== "string" || item.subcategory.trim() !== item.subcategory || item.subcategory.length < 1 || item.subcategory.length > 80 || /[<>\x00-\x1f\x7f]/u.test(item.subcategory))) return fail("subcategory");
  if (item.primarySubject === null && (item.secondarySubjects.length !== 0 || item.subcategory !== null)) return fail("unclassified");
  return { ok: true, value: Object.freeze({ version: 1, primarySubject: /** @type {string|null} */ (item.primarySubject), secondarySubjects: Object.freeze([...item.secondarySubjects]), subcategory: /** @type {string|null} */ (item.subcategory) }) };
}

// Provider schema uses exactly the same approved IDs as the runtime boundary.
export const CLASSIFICATION_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  required: ["version", "primarySubject", "secondarySubjects", "subcategory"],
  properties: {
    version: { type: "integer", enum: [1] },
    primarySubject: { anyOf: [{ type: "string", enum: SUBJECTS.map(s => s.id) }, { type: "null" }] },
    secondarySubjects: { type: "array", maxItems: 2, items: { type: "string", enum: SUBJECTS.map(s => s.id) } },
    subcategory: { anyOf: [{ type: "string", minLength: 1, maxLength: 80 }, { type: "null" }] },
  },
});
