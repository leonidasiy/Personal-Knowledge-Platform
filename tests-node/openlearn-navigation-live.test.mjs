import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectLessonContent,navigationModelTimeout,navigationDeadline,diagnosticNavigationTarget,navigationInventoryDigest,validateNavigationInventoryReview,serializeNavigationCapture} from '../scripts/openlearn-navigation-live.mjs';

// Constructed contract checks, not OpenLearn captures or real model output.
const url='https://example.test/course/lesson';
const page={evidence:{url,headings:[],images:[],warnings:[],blocks:[{id:'b1',locator:'main p',sectionId:'main',kind:'text',text:'Wanted relationship. Unwanted relationship.',figureId:null}]},navigation:{title:'Lesson',controls:[]}};
const lessOften=[{id:'skip',summary:'Unwanted relationship.'}];
const output={pageKind:'lesson',relevantContent:[{blockId:'b1',quote:'Wanted relationship.',topic:'Wanted'}],excludedContent:[{blockId:'b1',quote:'Unwanted relationship.',preferenceIds:['skip'],reason:'Same unwanted concept.'}],usefulImageIds:[],usefulMediaControlIds:[],notes:''};

test('capture evidence binds fresh block IDs and navigation even when text content is identical',()=>{
  const capture={sourceUrl:url,capturedAt:'2026-10-13T00:00:00Z',contentDigest:'same-text',evidence:page.evidence,navigation:page.navigation};
  const original=serializeNavigationCapture(capture),changedIds=structuredClone(capture),changedNavigation=structuredClone(capture);
  changedIds.evidence.blocks[0].id='fresh-block';changedNavigation.navigation.controls=[{id:'new-control',label:'Fresh panel'}];
  assert.notEqual(serializeNavigationCapture(changedIds).sha256,original.sha256);
  assert.notEqual(serializeNavigationCapture(changedNavigation).sha256,original.sha256);
  assert.deepEqual(JSON.parse(original.bytes),capture);
});

test('content discovery preserves wanted and excluded passages in one mixed block',async()=>{
  const inspected=await inspectLessonContent({page,lessOften,processedUrls:[url+'-prior'],generate:async command=>{
    assert.deepEqual(command.input.lessOften,lessOften);assert.deepEqual(command.input.processedUrls,[url+'-prior']);
    assert.match(command.systemPrompt,/not generated knowledge points or quizzes/);
    assert.match(command.systemPrompt,/excludedContent is ONLY educational content matching a supplied lessOften concept/);
    assert.match(command.systemPrompt,/never attach a preference ID to unrelated text/);
    return {ok:true,value:structuredClone(output)};
  }});
  assert.equal(inspected.ok,true);assert.deepEqual(inspected.value,output);
});

test('invented content, preferences and media IDs cannot pass discovery validation',async()=>{
  for(const change of [value=>value.relevantContent[0].quote='Invented.',value=>value.excludedContent[0].preferenceIds=['foreign'],value=>value.usefulImageIds=['invented'],value=>value.usefulMediaControlIds=['invented']]){
    const value=structuredClone(output);change(value);
    const inspected=await inspectLessonContent({page,lessOften,processedUrls:[],generate:async()=>({ok:true,value})});
    assert.equal(inspected.error.kind,'LessonContentOutputInvalid');
    assert.ok(Array.isArray(inspected.error.issues));
    if(value.relevantContent[0].quote==='Invented.')assert.match(inspected.error.issues[0],/relevantContent\[0\]: block ID or exact contiguous quote mismatch/);
  }
});

test('blocked content and invalid capture stop; model failures retain their named cause',async()=>{
  const blocked=await inspectLessonContent({page,lessOften,processedUrls:[],generate:async()=>({ok:true,value:{...output,pageKind:'blocked'}})});
  assert.equal(blocked.error.kind,'LessonContentBlocked');
  const invalid=await inspectLessonContent({page:{evidence:null},lessOften,processedUrls:[],generate:async()=>{throw new Error('Unexpected dispatch');}});
  assert.equal(invalid.error.kind,'LessonEvidenceInvalid');
  const failure=await inspectLessonContent({page,lessOften,processedUrls:[],generate:async()=>({ok:false,error:{kind:'ModelLimit'}})});
  assert.equal(failure.error.kind,'ModelLimit');
});

test('slow-model timeout uses the renewed clock and never extends its deadline',()=>{
  assert.equal(navigationModelTimeout({deadlineAtMs:1,effectiveDeadlineAtMs:null},2),120000);
  assert.equal(navigationDeadline({deadlineAtMs:1,effectiveDeadlineAtMs:null}),null);
  assert.equal(navigationModelTimeout({deadlineAtMs:1,effectiveDeadlineAtMs:200001},1),120000);
  assert.equal(navigationModelTimeout({deadlineAtMs:1,effectiveDeadlineAtMs:5001},1),5000);
  assert.throws(()=>navigationModelTimeout({deadlineAtMs:5000},5000),/NavigationDeadlineExceeded/);
});

test('diagnostic replays only the same unique actual observed navigation intent',()=>{
  const control={id:'fresh-18',label:'Observed lesson panel',role:'link',url:url+'?panel=lesson'};
  const navigation={url,controls:[control]};
  const previous={sourceUrl:url,control:{label:control.label,role:control.role,url:control.url}};
  assert.equal(diagnosticNavigationTarget(navigation,previous),control);
  assert.throws(()=>diagnosticNavigationTarget({...navigation,controls:[control,control]},previous),/NavigationDiagnosticTargetChanged/);
  assert.throws(()=>diagnosticNavigationTarget(navigation,{...previous,control:{...previous.control,url:url+'?panel=unobserved'}}),/NavigationDiagnosticTargetChanged/);
  assert.throws(()=>diagnosticNavigationTarget(navigation,{...previous,sourceUrl:url+'-different'}),/NavigationDiagnosticIntentInvalid/);
});

test('sequential content requires an independent review of the exact discovered order and scope',()=>{
  const plan={sourceRootUrl:url,lessonUrls:[url+'/first',url+'/second']};
  const review={version:'openlearn-inventory-review-v1',decision:'PASS',inventoryDigest:navigationInventoryDigest(plan),displayedOrderVerified:true,relevantLessonInventoryVerified:true,reviewer:'independent-fixture'};
  assert.equal(validateNavigationInventoryReview(plan,review).ok,true);
  for(const changed of [null,{...review,decision:'FAIL'},{...review,displayedOrderVerified:false},{...review,relevantLessonInventoryVerified:false},{...review,reviewer:''}])assert.equal(validateNavigationInventoryReview(plan,changed).error.kind,'NavigationInventoryReviewRequired');
  assert.equal(validateNavigationInventoryReview({...plan,lessonUrls:[...plan.lessonUrls].reverse()},review).ok,false);
  assert.equal(validateNavigationInventoryReview({...plan,sourceRootUrl:url+'/different'},review).ok,false);
});
