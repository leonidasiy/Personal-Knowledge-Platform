// @ts-check
/** @typedef {{readonly kind:'text',readonly id:string}} TextCitationReference */
/** @typedef {{readonly kind:'pixels',readonly id:string,readonly cue:string}} PixelCitationReference */
/** @typedef {{readonly reference:TextCitationReference,readonly sourceId:string,readonly locator:string,readonly text:string,readonly quoteDigest:string}} CapturedCitationSource */
/** @template T @typedef {{ok:true,value:T}|{ok:false,error:{kind:'CitationCaptureInvalid'|'CitationReferenceInvalid'}}} CitationResult */
/** @typedef {{readonly sources:readonly CapturedCitationSource[],resolve:(references:unknown)=>CitationResult<readonly CapturedCitationSource[]>}} CitationCapture */
/** @param {unknown} value @returns {value is Record<string,unknown>} */
const record=value=>typeof value==='object'&&value!==null&&!Array.isArray(value);
/** @param {unknown} value @returns {value is string} */
const text=value=>typeof value==='string'&&value.trim()!=='';
/** Hash literal UTF-8 source bytes, never normalized text. @param {string} value */
export async function quoteHash(value){
 if(typeof value!=='string')throw new TypeError('QuoteHashCommandInvalid');
 return `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('')}`;
}
/** A private immutable lookup binds references to one captured revision and owner.
 * The model selects opaque supplied identities; all text/locator/digests are application derived.
 * @param {{owner:string,sources:readonly {id:string,locator:string,text:string}[]}} command
 * @returns {Promise<CitationResult<CitationCapture>>} */
export async function captureCitationSources(command){
 if(!record(command)||Object.keys(command).sort().join(',')!=='owner,sources'||!text(command.owner)||!Array.isArray(command.sources)||command.sources.some(s=>!record(s)||Object.keys(s).sort().join(',')!=='id,locator,text'||!text(s.id)||!text(s.locator)||!text(s.text))||new Set(command.sources.map(s=>s.id)).size!==command.sources.length)return {ok:false,error:{kind:'CitationCaptureInvalid'}};
 const owner=command.owner,snapshot=command.sources.map(s=>({...s}));
 const sources=Object.freeze(await Promise.all(snapshot.map(async s=>Object.freeze({reference:Object.freeze({kind:/** @type {const} */('text'),id:'captured:'+await quoteHash(JSON.stringify([owner,s.id,s.locator,s.text]))}),sourceId:s.id,locator:s.locator,text:s.text,quoteDigest:await quoteHash(s.text)}))));
 const byId=new Map(sources.map(s=>[s.reference.id,s]));
 return {ok:true,value:Object.freeze({sources,/** @param {unknown} references @returns {CitationResult<readonly CapturedCitationSource[]>} */resolve(references){
  if(!Array.isArray(references))return {ok:false,error:{kind:'CitationReferenceInvalid'}};
  const seen=new Set();/** @type {CapturedCitationSource[]} */const resolved=[];
  for(const ref of references){
   if(!record(ref)||Object.keys(ref).sort().join(',')!=='id,kind'||ref.kind!=='text'||!text(ref.id)||seen.has(ref.id))return {ok:false,error:{kind:'CitationReferenceInvalid'}};
   const source=byId.get(ref.id);if(!source)return {ok:false,error:{kind:'CitationReferenceInvalid'}};
   seen.add(ref.id);resolved.push(source);
  }
  return {ok:true,value:Object.freeze(resolved)};
 }})};
}
