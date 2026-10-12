import {readFile} from 'node:fs/promises';
// Fresh parsed public metadata per caller; no mutable shared catalog or provider calls.
export async function readFrozenEvaluationCatalog(){
 return JSON.parse(await readFile(new URL('./catalog-model.json',import.meta.url),'utf8'));
}
