import {createHash} from 'node:crypto';
import {evaluationHash} from '../../../scripts/webpage-image-evaluation.mjs';
import {WEBPAGE_IMAGE_POLICY,WEBPAGE_EXTRACTION_POLICY} from '../../../worker/webpage-image-budget.js';
// Constructed here: not a real corpus, not owner thresholds, not model accuracy.
export function createSyntheticEvaluationFixture(){
 const base64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
 const image={id:'i',mediaType:'image/png',base64,digest:'sha256:'+createHash('sha256').update(Buffer.from(base64,'base64')).digest('hex')};
 const item={id:'fixture',sourceFamily:'synthetic',split:'holdout',origin:{kind:'synthetic-fixture',reference:'Constructed by webpage-image-evaluation.test.mjs; no real source',annotator:'scripted-unit-fixture'},input:{coverageGoals:[],evidence:{url:'https://synthetic.invalid/',headings:[],blocks:[{id:'b',locator:'p',sectionId:'s',kind:'text',text:'Synthetic relation. Another relation.',figureId:null}],images:[{id:'i',url:'https://synthetic.invalid/image.png',occurrences:[{id:'o',locator:'img',sectionId:'s',figureId:null,captionId:null,alt:''}],occurrenceWindows:[['o']]}],warnings:[]}},images:[image],labels:[{id:'matchable',summary:'Synthetic relation.',useful:true,matchable:true,acceptableImageIds:['i']},{id:'text-only',summary:'Another relation.',useful:true,matchable:false,acceptableImageIds:[]}]};
 const corpus={version:'synthetic-fixture-v1',cases:[item]};corpus.hash=evaluationHash(corpus);
 const config={version:'scripted-unit-fixture-v1',corpusVersion:corpus.version,corpusHash:corpus.hash,minimumHoldoutCases:1,sourceFamilySplits:{development:[],holdout:['synthetic']},model:{adapter:'openrouter-knowledge-model',name:'unexecuted-fixture-model',version:'unexecuted-fixture-v1',endpoint:'https://openrouter.ai/api/v1/chat/completions',timeoutMs:30000,maximumInputCharacters:3000000},promptVersions:{facts:'webpage-source-text-v1',match:'webpage-image-match-v1',verify:'webpage-image-verify-v1'},thresholds:{precision:1,matchableFactRecall:1,abstention:1,usefulTextCoverage:1},imagePolicy:WEBPAGE_IMAGE_POLICY,runPolicy:{maximumPages:WEBPAGE_EXTRACTION_POLICY.maximumPages,maximumDurationMs:WEBPAGE_EXTRACTION_POLICY.maximumDurationMs},budget:{maximumRequests:1,maximumOutputTokens:4096,maximumMilliseconds:30000}};
 return {config,corpus};
}
