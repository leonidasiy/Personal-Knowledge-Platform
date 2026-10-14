// @ts-check

/** @typedef {{readonly currentUrl:string|null,readonly pageTitle:string|null,readonly sectionTitle:string|null,readonly stage:string|null,readonly updatedAt:string|null,readonly knowledgePoints:readonly {readonly knowledgeId:string,readonly summary:string}[],readonly generatedQuizQuestions:number,readonly processedPageCount:number,readonly totalPages:number|null}} WorkflowProgress */
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === 'string' && value.trim() !== ''; }
/** @param {unknown} value @returns {value is number} */
function count(value) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }

/** The same public boundary is used by the worker projection and browser gateway.
 * Older status payloads can omit progress entirely.
 * @param {unknown} value @returns {WorkflowProgress|null} */
export function parseWorkflowProgress(value) {
  if (!record(value) || ![value.currentUrl,value.pageTitle,value.sectionTitle,value.stage,value.updatedAt].every(item => item === null || text(item)) || !Array.isArray(value.knowledgePoints) || !value.knowledgePoints.every(point => record(point) && text(point.knowledgeId) && text(point.summary)) || !count(value.generatedQuizQuestions) || value.processedPageCount !== undefined && !count(value.processedPageCount) || value.totalPages !== undefined && value.totalPages !== null && !count(value.totalPages)) return null;
  const currentUrl = /** @type {string|null} */(value.currentUrl), updatedAt = /** @type {string|null} */(value.updatedAt);
  if (currentUrl !== null && !URL.canParse(currentUrl) || updatedAt !== null && !Number.isFinite(Date.parse(updatedAt))) return null;
  if (currentUrl !== null) {
    const url = new URL(currentUrl);
    if (!['https:','http:'].includes(url.protocol) || url.username !== '' || url.password !== '') return null;
  }
  const points = /** @type {{knowledgeId:string,summary:string}[]} */ (value.knowledgePoints);
  if (new Set(points.map(point => point.knowledgeId)).size !== points.length) return null;
  return Object.freeze({currentUrl,pageTitle:/** @type {string|null} */(value.pageTitle),sectionTitle:/** @type {string|null} */(value.sectionTitle),stage:/** @type {string|null} */(value.stage),updatedAt,knowledgePoints:Object.freeze(points.map(point => Object.freeze({knowledgeId:point.knowledgeId,summary:point.summary}))),generatedQuizQuestions:value.generatedQuizQuestions,processedPageCount:/** @type {number} */(value.processedPageCount ?? 0),totalPages:/** @type {number|null} */(value.totalPages ?? null)});
}
