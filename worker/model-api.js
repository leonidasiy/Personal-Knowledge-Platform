// @ts-check

/** @param {Record<string, unknown>} environment */
export function resolveModelApi(environment) {
  const names = ['LLM_API_KEY', 'LLM_CHAT_ENDPOINT', 'LLM_MODEL', 'LLM_GRADING_MODEL', 'RERANK_API_KEY', 'RERANK_ENDPOINT', 'RERANK_MODEL'];
  for (const name of names) if (environment[name] !== undefined && (typeof environment[name] !== 'string' || !environment[name].trim())) return {ok:/** @type {const} */(false), error:{field:name}};
  const endpoint = String(environment.LLM_CHAT_ENDPOINT ?? 'https://openrouter.ai/api/v1/chat/completions');
  const rerankEndpoint = String(environment.RERANK_ENDPOINT ?? 'https://openrouter.ai/api/v1/rerank');
  for (const [name, value] of [['LLM_CHAT_ENDPOINT', endpoint], ['RERANK_ENDPOINT', rerankEndpoint]]) {
    if (!URL.canParse(value)) return {ok:/** @type {const} */(false), error:{field:name}};
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return {ok:/** @type {const} */(false), error:{field:name}};
  }
  const compatible = new URL(endpoint).origin !== 'https://openrouter.ai';
  // A replacement endpoint must never receive the original provider's credential.
  if (compatible && !environment.LLM_API_KEY) return {ok:/** @type {const} */(false), error:{field:'LLM_API_KEY'}};
  if (compatible && !environment.LLM_MODEL) return {ok:/** @type {const} */(false), error:{field:'LLM_MODEL'}};
  if (compatible && !environment.LLM_GRADING_MODEL) return {ok:/** @type {const} */(false), error:{field:'LLM_GRADING_MODEL'}};
  if (environment.RERANK_ENDPOINT && new URL(rerankEndpoint).origin !== 'https://openrouter.ai' && !environment.RERANK_API_KEY) return {ok:/** @type {const} */(false), error:{field:'RERANK_API_KEY'}};
  const apiKey = typeof environment.LLM_API_KEY === 'string' ? environment.LLM_API_KEY : typeof environment.OPENROUTER_API_KEY === 'string' ? environment.OPENROUTER_API_KEY : null;
  return {ok:/** @type {const} */(true), value:{
    apiKey, endpoint, model:String(environment.LLM_MODEL ?? 'z-ai/glm-5.3-flash'),
    apiStyle:/** @type {'openrouter'|'openai-compatible'} */(compatible ? 'openai-compatible' : 'openrouter'),
    gradingModel:typeof environment.LLM_GRADING_MODEL === 'string' ? environment.LLM_GRADING_MODEL : null,
    rerank:{endpoint:rerankEndpoint, model:String(environment.RERANK_MODEL ?? 'cohere/rerank-4-fast'), apiKey:typeof environment.RERANK_API_KEY === 'string' ? environment.RERANK_API_KEY : environment.RERANK_ENDPOINT || compatible ? null : apiKey},
  }};
}
