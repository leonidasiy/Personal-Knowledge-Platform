// @ts-check
import { isIsoDateTime, isNonEmptyText, isPublicHttpsUrl, isRecord, validatePublisherDestination } from "./contracts.js";

/** @typedef {{readonly kind:"SubmittedLinkCommandInvalid",readonly field:string}} SubmittedLinkFailure */
/** @param {unknown} input @param {string} observedAt @returns {import('./contracts.js').Result<Omit<import('./service.js').ValidatedApproval,'ownerId'> & {readonly identityStatus:"resolved"},SubmittedLinkFailure>} */
export function prepareSubmittedLink(input, observedAt) {
  const checked=validateSubmittedLink(input);
  if (!checked.ok) return checked;
  if (!isIsoDateTime(observedAt)) return {ok:false,error:{kind:"SubmittedLinkCommandInvalid",field:"observedAt"}};
  const {title,url,interestAreaId,idempotencyKey}=checked.value;
  return {ok:true,value:Object.freeze({
    identityStatus:"resolved", title, description:"",
    submittedUrl:url, canonicalUrl:url, interestAreaIds:[interestAreaId],
    idempotencyKey,
    adapter:{id:"submitted-link",version:"v1",granularity:"document",capabilities:["metadata","bounded-ingestion"]},
    identityEvidence:[{attribute:"user-submitted-url",value:url,provenanceUrl:url,observedAt}], initialItem:null,
  })};
}

/** @typedef {{readonly title:string,readonly url:string,readonly interestAreaId:string,readonly idempotencyKey:string}} SubmittedLinkCommand */
/** @param {unknown} input @returns {import('./contracts.js').Result<SubmittedLinkCommand,SubmittedLinkFailure>} */
export function validateSubmittedLink(input) {
  /** @param {string} field @returns {import('./contracts.js').Result<never,SubmittedLinkFailure>} */
  const invalid = field => ({ok:false,error:{kind:"SubmittedLinkCommandInvalid",field}});
  if (!isRecord(input) || Object.keys(input).length !== 4 || !Object.keys(input).every(key => ["title","url","interestAreaId","idempotencyKey"].includes(key))) return invalid("command");
  for (const field of ["title","interestAreaId","idempotencyKey"]) if (!isNonEmptyText(input[field])) return invalid(field);
  if (/** @type {string} */(input.title).trim().length > 300) return invalid("title");
  if (!isPublicHttpsUrl(input.url) || !validatePublisherDestination(input.url).ok) return invalid("url");
  const url = new URL(/** @type {string} */(input.url)).href;
  return {ok:true,value:{title:/** @type {string} */(input.title).trim(),url,interestAreaId:/** @type {string} */(input.interestAreaId).trim(),idempotencyKey:/** @type {string} */(input.idempotencyKey).trim()}};
}
