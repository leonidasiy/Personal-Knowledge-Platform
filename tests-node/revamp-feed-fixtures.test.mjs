import {readFileSync} from 'node:fs';
const shell=readFileSync(new URL('../index.html',import.meta.url),'utf8');
Object.defineProperty(globalThis,'document',{configurable:true,value:{getElementById:id=>{const content=shell.match(new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`))?.[1];return content===undefined?null:{textContent:content};}}});
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {revampFeedFixture} from './fixtures/learning-generation/revamp-feed.mjs';
import {LearningBatchGatewayClient} from '../src/features/learning-generation/batches-gateway.js';
import {createLearnerController} from '../src/features/learning-generation/learner.js';

/** @param {unknown} value @param {number} [status] */
const load = (value, status = 200) => new LearningBatchGatewayClient({
 fetch: async () => Response.json({result: value}, {status}),
 baseUrl: 'https://app.example/', timeoutMs: 1000,
}).loadFeed('2026-09-19');

test('actual verifier Feed payload passes the real gateway and renders five cards', async () => {
 const fixture = await revampFeedFixture();
 const controller = createLearnerController({fetch: async () => Response.json({result: fixture}),
  baseUrl: 'https://app.example/', timeoutMs: 1000, escapeHtml: value => value,
  now: () => '2026-09-19T12:00:00.000Z', createId: () => 'fixture', onChange: () => {},
 });
 const result = await controller.loadFeed();
 assert.equal(result.ok, true);
 assert.equal((controller.renderFeed().match(/class="learning-card"/g) ?? []).length, 5);
 assert.equal(result.value.items.length, 5);
 assert.ok(result.value.items.every(card => card.sourceRevision === 1));
});

test('Feed empty and 401 boundaries remain explicit', async () => {
 assert.deepEqual(await load({batch: null, items: []}), {ok: true, value: {batch: null, items: []}});
 assert.deepEqual(await load(await revampFeedFixture(), 401), {ok: false, error: {kind: 'LearningBatchGatewayUnauthenticated'}});
});

test('Feed rejects each missing source metadata field without weakening the gateway', async () => {
 const fixture = await revampFeedFixture();
 for (const field of ['sourceRevision', 'sourceClassification', 'sourceClassificationRevision']) {
  const value = structuredClone(fixture);
  delete value.items[0][field];
  assert.deepEqual(await load(value), {ok: false, error: {kind: 'LearningBatchGatewayResponseInvalid'}}, field);
 }
});

test('Feed source revision and classification boundaries use the existing schema', async () => {
 const fixture = await revampFeedFixture();
 const unclassified = structuredClone(fixture);
 Object.assign(unclassified.items[0], {sourceClassification: null, sourceClassificationRevision: 0});
 assert.equal((await load(unclassified)).ok, true);
 for (const change of [{sourceRevision: 0}, {sourceClassificationRevision: -1},
  {sourceClassification: null, sourceClassificationRevision: 1},
  {sourceClassification: {mainSubject: 'unknown-fixture-subject', topic: 'Synthetic source context'}}]) {
  const value = structuredClone(fixture); Object.assign(value.items[0], change);
  assert.deepEqual(await load(value), {ok: false, error: {kind: 'LearningBatchGatewayResponseInvalid'}});
 }
});
