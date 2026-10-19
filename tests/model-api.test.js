// @ts-check
import {assertEquals} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {resolveModelApi} from '../worker/model-api.js';
import {createJevAnswerGrader,JEV_GRADER_CONFIGURATION} from '../worker/jev-answer-grader.js';
import {createSemanticRanker} from '../worker/local-semantic-index.js';

Deno.test('replacement API configuration isolates credentials and rejects unsafe endpoints',()=>{
  const base={LLM_CHAT_ENDPOINT:'https://models.example.test/v1/chat/completions',LLM_MODEL:'another-model',LLM_GRADING_MODEL:'another-grader',OPENROUTER_API_KEY:'original-secret'};
  const missing=resolveModelApi(base);assertEquals(missing.ok,false);assertEquals(missing.error?.field,'LLM_API_KEY');
  for(const endpoint of ['http://models.example.test/chat','https://user:password@models.example.test/chat','https://models.example.test/chat?api_key=secret','https://models.example.test/chat#secret','invalid'])assertEquals(resolveModelApi({...base,LLM_API_KEY:'own-key',LLM_CHAT_ENDPOINT:endpoint}).ok,false);
  assertEquals(resolveModelApi({...base,LLM_CHAT_ENDPOINT:'https://openrouter.ai:8443/chat'}).ok,false);
  const result=resolveModelApi({...base,LLM_API_KEY:'own-key'});
  if(!result.ok)throw new Error('Configuration rejected.');
  assertEquals(result.value.apiKey,'own-key');assertEquals(result.value.apiStyle,'openai-compatible');assertEquals(result.value.rerank.apiKey,null);
  assertEquals(resolveModelApi({...base,LLM_API_KEY:'own-key',RERANK_ENDPOINT:'https://rerank.example.test/v2/rerank'}).ok,false);
});

Deno.test('compatible grader validates exact probabilities, bounds and malformed output',async()=>{
  for(const [index,output] of [{probabilities:{answer:0.8}},{probabilities:{answer:1.1}},{probabilities:{wrong:0.8}},{probabilities:{answer:'0.8'}},{probabilities:{answer:0.8},unexpected:true}].entries()){
    const grader=createJevAnswerGrader({apiKey:'own-key',configuration:JEV_GRADER_CONFIGURATION,chat:{endpoint:'https://models.example.test/v1/chat/completions',model:'different-grader',apiStyle:'openai-compatible'},timeoutMs:1000,logger:()=>{},fetch:async(url,init)=>{
      assertEquals(String(url),'https://models.example.test/v1/chat/completions');assertEquals(new Headers(init?.headers).get('authorization'),'Bearer own-key');assertEquals(init?.redirect,'manual');
      const body=JSON.parse(String(init?.body));assertEquals(body.model,'different-grader');assertEquals(body.provider,undefined);assertEquals(body.reasoning,undefined);
      return Response.json({id:'synthetic-grading',choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]});
    }});
    const result=await grader.grade({prompt:'Synthetic question',answers:[{id:'answer',response:'Synthetic paraphrase',canonicalAnswers:['Synthetic canonical']}]});
    assertEquals(result.ok,index===0);
    if(result.ok){assertEquals(result.value.model,'different-grader');assertEquals(result.value.accepted[0],true);}
  }
  for(const [status,kind] of [[401,'JevCredentialMissing'],[429,'JevRateLimited'],[503,'JevProviderUnavailable'],[400,'JevProviderRejected']]){
    const grader=createJevAnswerGrader({apiKey:'own-key',configuration:JEV_GRADER_CONFIGURATION,chat:{endpoint:'https://models.example.test/v1/chat/completions',model:'different-grader',apiStyle:'openai-compatible'},timeoutMs:1000,logger:()=>{},fetch:async()=>Response.json({error:{}},{status:Number(status)})});
    const result=await grader.grade({prompt:'Synthetic question',answers:[{id:'answer',response:'Synthetic paraphrase',canonicalAnswers:['Synthetic canonical']}]});
    assertEquals(result.ok,false);if(!result.ok)assertEquals(result.error.kind,kind);
  }
});

Deno.test('reranker substitutes endpoint, model and credential while retaining its response contract',async()=>{
  const ranker=createSemanticRanker({apiKey:'rerank-key',endpoint:'https://rerank.example.test/v2/rerank',model:'different-reranker',maximumCandidates:20,timeoutMs:3000,logger:()=>{},fetch:async(url,init)=>{
    assertEquals(String(url),'https://rerank.example.test/v2/rerank');assertEquals(new Headers(init?.headers).get('authorization'),'Bearer rerank-key');assertEquals(JSON.parse(String(init?.body)).model,'different-reranker');return Response.json({results:[{index:0,relevance_score:0.9}]});
  }});
  const result=await ranker.rank({query:'synthetic',scope:'sources',limit:1,candidates:[{id:'candidate',sourceId:'source',sourceRevision:1,title:'Synthetic title',text:'Synthetic text'}]});
  assertEquals(result.ok,true);if(result.ok)assertEquals(result.value.modelId,'different-reranker');
});
