// Synthetic contract decisions only; never evidence of real model classification accuracy.
/** @param {import('../worker/discovery-search.js').CentralSearchCandidate} candidate @param {number} index @returns {import('../worker/discovery-source-assessment.js').SourceAssessment} */
export function summaryAssessment(candidate, index) {
  const candidateId = `c${index}`;
  const refs = candidate.identityEvidence.map((entry, i) => ({id:`${candidateId}:e${i}`, scope: /** @type {'summary'|'reference'} */(['provider-result-description','taddy-series-description'].includes(entry.attribute) ? 'summary' : 'reference')}));
  refs.push({id:`${candidateId}:title`,scope:'reference'});
  if(candidate.description !== null && candidate.description.trim() !== '')refs.push({id:`${candidateId}:description`,scope:'summary'});
  if(candidate.publisherLabel !== null)refs.push({id:`${candidateId}:publisher`,scope:'reference'});
  const summary = refs.find(ref => ref.scope === 'summary');
  if(summary === undefined)throw new Error('Synthetic eligible fixture needs an attributed descriptive summary.');
  return {candidateId,relevance:'relevant',substance:'explanatory',provenance:'evidenced',selection:'eligible',qualityScope:'provider-summary',reason:'Synthetic supplied summary supports the topic; full content unverified',evidenceRefs:[summary.id],evidence:{canonicalUrl:candidate.canonicalUrl,scopes:Object.fromEntries(refs.map(ref=>[ref.id,ref.scope]))}};
}
/** @template {{items:import('../worker/discovery-search.js').CentralSearchCandidate[],assessments:unknown[]}} T @param {T} result */
export function withSummaryAssessments(result) { return {...result,assessments:result.items.map(summaryAssessment)}; }
