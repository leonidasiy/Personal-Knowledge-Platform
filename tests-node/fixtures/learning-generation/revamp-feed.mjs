import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {SUBJECTS} from '../../../src/features/knowledge-subjects/public.js';

// Read the verifier's actual payload; every expression dependency is explicit.
/** @returns {Promise<{batch: unknown, items: Record<string, unknown>[]}>} */
export async function revampFeedFixture() {
 const script = await readFile(new URL('../../../scripts/check-frontend-revamp.mjs', import.meta.url), 'utf8');
 /** @param {string} name @returns {unknown} */
 const constant = name => {
  const expression = script.match(new RegExp(`^const ${name} = (.+);$`, 'm'))?.[1];
  assert(expression, `Missing verifier constant: ${name}`);
  return runInNewContext(`(${expression})`, {now}, {timeout: 1000});
 };
 const now = script.match(/^const now = "([^"]+)";$/m)?.[1];
 assert(now, 'Missing verifier timestamp');
 const expression = script.match(/return respond\((\{ batch: .+items: batch\.itemIds\.map.+)\);/)?.[1];
 assert(expression, 'Missing verifier Feed payload');
 /** @type {unknown} */
 const value = JSON.parse(JSON.stringify(runInNewContext(`(${expression})`, {
  now, source: constant('source'), batch: constant('batch'), completed: false, SUBJECTS,
 }, {timeout: 1000})));
 assert(value && typeof value === 'object' && 'batch' in value && 'items' in value && Array.isArray(value.items), 'Invalid verifier Feed envelope');
 assert(value.items.every(/** @param {unknown} item */ item => item && typeof item === 'object' && !Array.isArray(item)), 'Invalid verifier Feed cards');
 return /** @type {{batch: unknown, items: Record<string, unknown>[]}} */ (value);
}
