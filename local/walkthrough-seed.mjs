import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createLearningBatchService } from '../worker/learning-batches-d1.js';
import { isKnowledgeWorkflowRun } from '../src/features/knowledge-workflows/workflow.js';

export const WALKTHROUGH_OWNER = 'self-host-owner-v1';
const content = JSON.parse(await readFile(new URL('./walkthrough-content.json', import.meta.url), 'utf8'));
const dayMs = 86_400_000;
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const value = result => {
  if (!result.ok) throw new Error(`Walkthrough setup failed: ${result.error.kind}`);
  return result.value;
};

// Only the disposable walkthrough launcher calls this; never seed an existing library.
export async function seedWalkthrough(database, now = new Date().toISOString()) {
  if (!Number.isFinite(Date.parse(now))) throw new TypeError('Walkthrough date is invalid.');
  const db = database.sqlite;
  for (const table of ['library_sources', 'knowledge_workflow_runs', 'learner_feed_batches', 'learner_review_batches', 'learner_knowledge_state', 'learner_question_state', 'learner_review_answers', 'learner_preference_feedback', 'learner_batch_commands']) {
    if (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n !== 0) throw new Error('Walkthrough seeding requires an empty database. Personal records must never be used.');
  }
  const at = (daysAgo, minutes = 0) => new Date(Date.parse(now) - daysAgo * dayMs + (minutes - 60) * 60_000).toISOString();
  const owner = WALKTHROUGH_OWNER;
  let knowledgePoints = 0;
  database.transactionSync(() => {
    for (const [sourceIndex, source] of content.sources.entries()) {
      const sourceId = `walkthrough:${source.id}`, runId = `${sourceId}:run`, createdAt = at(29, sourceIndex);
      const counts = { pages: 1, knowledgePoints: source.points.length, acceptedQuizzes: source.points.length, pendingQuizzes: 0 };
      const run = { ownerId: owner, runId, sourceId, sourceRevision: 1, canonicalSourceIdentity: source.url, contentSignature: hash(JSON.stringify(source)), extractionScope: 'page', state: 'completed', revision: 1, idempotencyKey: runId, configDigests: { walkthrough: 'synthetic-fixture-v1' }, extractionStartedAt: null, extractionDeadlineAt: null, decisionRequired: null, counts, failureKind: null, reused: false, createdAt, updatedAt: createdAt };
      if (!isKnowledgeWorkflowRun(run)) throw new Error('Walkthrough workflow contract is invalid.');
      db.prepare('INSERT INTO library_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(owner, sourceId, source.url, source.url, source.title, `Walkthrough sample · ${content.attribution} ${content.licence}`, JSON.stringify({ id: 'webpage', version: '1', granularity: 'page', capabilities: ['public-text'] }), JSON.stringify([{ attribute: 'sample-provenance', value: content.provenance, provenanceUrl: source.url, observedAt: now }]), 'active', createdAt, createdAt, 1);
      db.prepare('INSERT INTO source_interest_areas VALUES(?,?,?,?)').run(owner, sourceId, 'music', createdAt);
      db.prepare('INSERT INTO knowledge_workflow_runs(owner_id,run_id,source_id,source_revision,canonical_source_identity,content_signature,state,revision,idempotency_key,config_digests_json,counts_json,reused,created_at,updated_at,run_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(owner, runId, sourceId, 1, source.url, run.contentSignature, 'completed', 1, runId, JSON.stringify(run.configDigests), JSON.stringify(counts), 0, createdAt, createdAt, JSON.stringify(run));
      db.prepare('INSERT INTO source_classifications(owner_id,source_id,source_revision,main_subject,topic,classification_revision,origin,status,legacy_audit_json,updated_at,run_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(owner, sourceId, 1, 'music', source.topic, 1, 'manual', 'classified', JSON.stringify({ walkthrough: true, provenance: content.provenance }), createdAt, runId);
      for (const [index, sample] of source.points.entries()) {
        const knowledgeId = `${sourceId}:point-${index + 1}`, taskId = `${knowledgeId}:quiz`, generationId = `${knowledgeId}:generation`, anchorId = `${knowledgeId}:evidence`;
        const point = { id: knowledgeId, sourceId, sourceRevision: 1, summary: sample.summary, normalizedHash: hash(sample.summary), evidenceAnchors: [{ id: anchorId, url: source.url, selector: sample.section }], attribution: { sourceUrl: source.url, title: source.title, licence: content.licence, attribution: content.attribution }, provenance: content.provenance };
        const choices = sample.choices.map((label, i) => ({ id: `option-${i + 1}`, label }));
        const task = { id: taskId, kind: 'single-choice', prompt: sample.prompt, explanation: sample.summary, sourceAnchorIds: [anchorId], choices, correctChoiceIds: ['option-1'], revision: 1 };
        knowledgePoints++;
        db.prepare('INSERT INTO extraction_knowledge_points VALUES(?,?,?,?,?,?,?,?)').run(owner, runId, knowledgeId, sourceId, 1, point.normalizedHash, JSON.stringify(point), createdAt);
        db.prepare('INSERT INTO learning_generation_jobs(owner_id,generation_id,source_id,source_revision,item_id,item_version_id,content_digest,source_kind,rights_evidence_id,attribution_json,policy_version,status,local_only,idempotency_key,command_fingerprint,record_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(owner, generationId, sourceId, 1, knowledgeId, 'v1', point.normalizedHash, 'public-text', 'walkthrough-cc-by-sa', JSON.stringify(point.attribution), 'walkthrough-v1', 'completed', 1, generationId, point.normalizedHash, JSON.stringify({ walkthrough: true, provenance: content.provenance }), createdAt);
        db.prepare('INSERT INTO learning_generation_tasks VALUES(?,?,?,?,?,?,?,?,?)').run(owner, generationId, taskId, 1, knowledgeId, 'v1', 'published', 1, JSON.stringify(task));
        // Synthetic score satisfies the stored fixture schema; it is not a model review.
        db.prepare('INSERT INTO knowledge_workflow_quizzes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(owner, taskId, runId, knowledgeId, sourceId, 1, hash(JSON.stringify(task)), JSON.stringify({ ...task, walkthrough: true, provenance: content.provenance, evaluation: 'synthetic-schema-fixture' }), 8, 1, 'published', createdAt);
      }
    }
  });

  // Replay normal application services so attempts, feedback and schedules agree.
  let clock = at(29), randomState = 19;
  const service = createLearningBatchService({ database, now: () => clock, random: () => { randomState = (randomState * 16807) % 2147483647; return randomState / 2147483647; }, logger() {} });
  let attempts = 0;
  for (let daysAgo = 28; daysAgo >= 1; daysAgo--) {
    if ([27, 23, 20, 16, 12, 9, 5, 2].includes(daysAgo)) continue;
    clock = at(daysAgo);
    const day = clock.slice(0, 10);
    const feed = value(await service.loadFeed(owner, day));
    if (feed.batch) value(await service.completeFeed({ ownerId: owner, batchId: feed.batch.batchId, idempotencyKey: `walkthrough:complete:${day}` }));
    clock = at(daysAgo, 20);
    const review = value(await service.loadReview(owner, day));
    for (const [index, question] of review.questions.entries()) {
      clock = at(daysAgo, 21 + index);
      // Missed recalls in the last session leave a full due batch for recording.
      const correct = daysAgo !== 1 && (attempts + daysAgo) % (daysAgo > 15 ? 3 : 5) !== 0;
      value(await service.answerReview({ ownerId: owner, batchId: review.batch.batchId, questionId: question.questionId, questionRevision: question.revision, selectedChoiceIds: [correct ? 'option-1' : 'option-2'], idempotencyKey: `walkthrough:answer:${day}:${question.questionId}` }));
      attempts++;
    }
  }
  return { sources: content.sources.length, knowledgePoints, quizzes: knowledgePoints, attempts, startedAt: at(29), generatedAt: now };
}
