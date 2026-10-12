// @ts-check
/** Parsed top-level error.message only. Never accepts provider metadata or raw bodies.
 * @typedef {{errorMessage:string|null,messageDisposition:'retained'|'absent'|'omitted-unsafe'}} ProviderMessage */
/** @param {unknown} value @param {readonly unknown[]} [privateInputs] @returns {ProviderMessage} */
export function projectProviderMessage(value,privateInputs=[]) {
 if(typeof value!=='string'||value.trim()==='')return {errorMessage:null,messageDisposition:'absent'};
 /** @type {string[]} */const strings=[];
 /** @param {unknown} input */
 function collect(input){if(typeof input==='string'&&input.length>=8)strings.push(input);else if(Array.isArray(input))input.forEach(collect);else if(input&&typeof input==='object')Object.values(input).forEach(collect);}
 privateInputs.forEach(collect);
 const normalizedPrivate=strings.map(s=>s.replace(/\s+/gu,' ').toLowerCase());
 const normalizedMessage=value.replace(/\s+/gu,' ').toLowerCase();
 if(strings.some(s=>value.includes(s))||Array.from({length:Math.max(0,normalizedMessage.length-11)},(_,i)=>normalizedMessage.slice(i,i+12)).some(part=>/^[a-z0-9 ]+$/u.test(part)&&normalizedPrivate.some(s=>s.includes(part))))return {errorMessage:null,messageDisposition:'omitted-unsafe'};
 // Echoes and credential/URL markers are omitted wholesale: partial redaction can retain private context.
 if(value.length>4096||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>\[\]{}]/u.test(value)||/\b(?:bearer|authorization|api[ _-]?key|password|secret|credential|token\s*[:=]|prompt\s*[:=]|input\s*[:=]|output\s*[:=]|completion\s*[:=])|secret|credential|sk-[\w-]+|https?:\/\/|data:/iu.test(value))return {errorMessage:null,messageDisposition:'omitted-unsafe'};
 const normalized=value.replace(/\s+/gu,' ').trim();let bounded='';
 for(const c of normalized){if(new TextEncoder().encode(bounded+c).length>256)break;bounded+=c;}
 return {errorMessage:bounded,messageDisposition:'retained'};
}
/** @param {unknown} value @returns {value is ProviderMessage} */
export function isProviderMessage(value) {
 if(!value||typeof value!=='object')return false;
 const v=/** @type {Record<string,unknown>} */(value);
 if(v.messageDisposition==='absent'||v.messageDisposition==='omitted-unsafe')return v.errorMessage===null;
 if(v.messageDisposition!=='retained'||typeof v.errorMessage!=='string'||new TextEncoder().encode(v.errorMessage).length>256)return false;
 const projected=projectProviderMessage(v.errorMessage);return projected.messageDisposition==='retained'&&projected.errorMessage===v.errorMessage;
}

/** Provider-reported interrupted completion. The first choice is the public consumer's choice;
 * other finish reasons never imply a technical recovery. No model content is inspected.
 * @param {unknown} document @returns {boolean} */
export function isProviderErrorTermination(document) {
 if(!document||typeof document!=="object"||Array.isArray(document))return false;
 const choices=/** @type {Record<string,unknown>} */(document).choices;
 if(!Array.isArray(choices)||!choices.length)return false;
 const choice=choices[0];
 return !!choice&&typeof choice==="object"&&!Array.isArray(choice)&&choice.finish_reason==="error";
}
