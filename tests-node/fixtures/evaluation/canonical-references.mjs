import assert from 'node:assert/strict';
// Explicit fixture selection from the model input; never a production/legacy fallback.
export function textReference(command,sourceId='b'){
 const source=command.input.citationSources.find(s=>s.sourceId===sourceId);
 assert(source,'fixture must select a supplied captured source');return structuredClone(source.reference);
}
