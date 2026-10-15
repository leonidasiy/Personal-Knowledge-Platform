import {test} from 'node:test';
import assert from 'node:assert/strict';
import {capturedImageDecision,selectCapturedImages,isCapturedImageCaption} from '../worker/url-capture-association.js';
import {createJevDecisionModel,JEV_GRADER_CONFIGURATION} from '../worker/jev-answer-grader.js';
const points=[{id:'one',summary:'Attention combines context-dependent information.'},{id:'two',summary:'Positional encodings represent sequence order.'},{id:'three',summary:'Unrelated relationship.'}];
const image=id=>({path:id,url:'https://cdn.example.org/figure.png',caption:'Author caption',alt:'Diagram',context:'Captured context',bytes:new Uint8Array([1]),mediaType:'image/png'});
const caption={description:'Arrows combine values using attention weights.',visibleText:'Q K V'};
test('every point receives an independent support question, without forced or exact matching',()=>{
 const input=capturedImageDecision(image('image:1'),caption,points);
 assert.deepEqual(Object.keys(input.questions),['point_0','point_1','point_2']);
 assert.equal(input.state.knowledge.point_0,points[0].summary);
 for(const question of Object.values(input.questions)){assert.equal(question.type,'noul');assert.match(question.instructions,/not exact wording/);assert.match(question.criteria.true,/illustrative example/);assert.match(question.criteria.false,/only shared keywords/);}
 assert(isCapturedImageCaption(caption));assert(!isCapturedImageCaption({...caption,extra:true}));assert(!isCapturedImageCaption({...caption,description:''}));
});
test('80 percent is inclusive, highest score wins per point, unmatched points stay text-only',()=>{
 const selected=selectCapturedImages(points,[{image:image('image:1'),caption,model:'typesafe/jev-1.13',probabilities:[0.8,0.79,0.1]},{image:image('image:2'),caption,model:'typesafe/jev-1.13',probabilities:[0.93,0.8,0.799999]}]);
 assert.equal(selected.size,2);assert.equal(selected.get('one').image.path,'image:2');assert.equal(selected.get('one').score,0.93);assert.equal(selected.get('two').score,0.8);assert(!selected.has('three'));
 assert.throws(()=>selectCapturedImages(points,[{image:image('image:1'),caption,model:'typesafe/jev-1.13',probabilities:[1]}]),/CapturedImageScoresInvalid/);
 assert.throws(()=>selectCapturedImages(points,[{image:image('image:1'),caption,model:'typesafe/jev-1.13',probabilities:[NaN,1,1]}]),/CapturedImageScoresInvalid/);
});
test('Jev adapter validates all independent probabilities and refuses foreign or missing answers',async()=>{
 let payload;
 const model=createJevDecisionModel({apiKey:'fixture',configuration:JEV_GRADER_CONFIGURATION,timeoutMs:1000,logger:()=>{},fetch:async(url,init)=>{assert.equal(url,JEV_GRADER_CONFIGURATION.endpoint);payload=JSON.parse(init.body);return Response.json({model:'typesafe/jev-1.13',answers:Object.fromEntries(Object.keys(payload.questions).map((id,i)=>[id,{type:'noul',noul:[0.9,0.8,0.2][i]}]))});}});
 const result=await model.decide(capturedImageDecision(image('image:1'),caption,points));assert.equal(result.ok,true);assert.deepEqual(result.value.probabilities,[0.9,0.8,0.2]);assert.equal(payload.model,JEV_GRADER_CONFIGURATION.requestedModel);
 const bad=createJevDecisionModel({apiKey:'fixture',configuration:JEV_GRADER_CONFIGURATION,timeoutMs:1000,logger:()=>{},fetch:async()=>Response.json({model:'typesafe/jev-1.13',answers:{point_0:{type:'noul',noul:0.9}}})});assert.equal((await bad.decide(capturedImageDecision(image('image:1'),caption,points))).error.kind,'JevResponseInvalid');
 const unavailable=createJevDecisionModel({apiKey:'fixture',configuration:JEV_GRADER_CONFIGURATION,timeoutMs:1000,logger:()=>{},fetch:async()=>new Response(null,{status:503})});assert.equal((await unavailable.decide(capturedImageDecision(image('image:1'),caption,points))).error.kind,'JevProviderUnavailable');
});
