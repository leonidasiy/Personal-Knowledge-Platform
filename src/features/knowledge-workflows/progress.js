// @ts-check

/** @typedef {{readonly currentUrl:string|null,readonly pageTitle:string|null,readonly sectionTitle:string|null,readonly stage:string|null,readonly updatedAt:string|null,readonly knowledgePoints:readonly {readonly knowledgeId:string,readonly summary:string}[],readonly generatedQuizQuestions:number,readonly processedPageCount:number,readonly totalPages:number|null,readonly failedQuizItems?:readonly {readonly knowledgeId:string,readonly summary:string,readonly failureKind:string,readonly attempts:number}[],readonly failedItems?:readonly {readonly url:string,readonly title:string,readonly failureKind:string,readonly attempts:number}[]}} WorkflowProgress */
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
  const failedQuizItems=value.failedQuizItems??[];
  if(!Array.isArray(failedQuizItems)||!failedQuizItems.every(item=>record(item)&&text(item.knowledgeId)&&text(item.summary)&&text(item.failureKind)&&item.attempts===4)||new Set(failedQuizItems.map(item=>item.knowledgeId)).size!==failedQuizItems.length)return null;
  const failedItems = value.failedItems ?? [];
  if (!Array.isArray(failedItems) || !failedItems.every(item => record(item) && text(item.url) && URL.canParse(item.url) && new URL(item.url).protocol === 'https:' && !new URL(item.url).username && !new URL(item.url).password && text(item.title) && text(item.failureKind) && count(item.attempts) && item.attempts > 0) || new Set(failedItems.map(item => item.url)).size !== failedItems.length) return null;
  const points = /** @type {{knowledgeId:string,summary:string}[]} */ (value.knowledgePoints);
  if (new Set(points.map(point => point.knowledgeId)).size !== points.length) return null;
  return Object.freeze({currentUrl,pageTitle:/** @type {string|null} */(value.pageTitle),sectionTitle:/** @type {string|null} */(value.sectionTitle),stage:/** @type {string|null} */(value.stage),updatedAt,knowledgePoints:Object.freeze(points.map(point => Object.freeze({knowledgeId:point.knowledgeId,summary:point.summary}))),generatedQuizQuestions:value.generatedQuizQuestions,processedPageCount:/** @type {number} */(value.processedPageCount ?? 0),totalPages:/** @type {number|null} */(value.totalPages ?? null),...(failedQuizItems.length?{failedQuizItems:Object.freeze(failedQuizItems.map(item=>Object.freeze({knowledgeId:item.knowledgeId,summary:item.summary,failureKind:item.failureKind,attempts:item.attempts})))}:{}),...(failedItems.length ? {failedItems:Object.freeze(failedItems.map(item => Object.freeze({url:item.url,title:item.title,failureKind:item.failureKind,attempts:item.attempts})))} : {})});
}
