// @ts-check

import {
  isIsoDateTime,
  isNonEmptyText,
  isPositiveInteger,
  isPublicHttpsUrl,
  isRecord,
} from "../src/features/source-library/ingestion-contracts.js";

/** @import { BrowserRunAcquisitionBatch, BrowserRunReservation, Result, ServerRightsGrant, SourceContentReference, SourceIngestionCommit, SourceIngestionCursor, SourceIngestionFailure, SourceIngestionLease, SourceItemVersion, SourcePolicyAssessmentCommand, SourceRightsAssessment, TrustedSourceIngestionJob } from "../src/features/source-library/ingestion-contracts.js" */

const freeze = Object.freeze;
const encoder = new TextEncoder();

export class SourceIngestionRunner {
  #dependencies;

  /** @param {{
   *   readonly policy: { readonly assess: (command: unknown) => Result<import("../src/features/source-library/ingestion-contracts.js").SourceCrawlPlan, SourceIngestionFailure>, readonly checkBoundary: (observation: unknown) => Result<{ readonly state: "within-policy" }, SourceIngestionFailure> },
   *   readonly repository: {
   *     readonly loadRunnable: (command: { readonly ownerId: string, readonly jobId: string }) => Promise<Result<TrustedSourceIngestionJob, SourceIngestionFailure>>,
   *     readonly lease: (lease: SourceIngestionLease, planJson: string, cursor: SourceIngestionCursor) => Promise<Result<SourceIngestionLease, SourceIngestionFailure>>,
   *     readonly recordMetadataOnly: (job: TrustedSourceIngestionJob, reason: string, recordedAt: string) => Promise<Result<null, SourceIngestionFailure>>,
   *     readonly markGenerationState?: (command: { readonly ownerId: string, readonly jobId: string, readonly state: "completed" | "failed", readonly failureKind: string | null, readonly updatedAt: string }) => Promise<Result<null, SourceIngestionFailure>>,
   *     readonly commit: (commit: SourceIngestionCommit) => Promise<Result<{ readonly state: "completed" | "partial" }, SourceIngestionFailure>>
   *   },
   *   readonly rightsRegistry: { readonly resolve: (job: TrustedSourceIngestionJob) => Promise<Result<ServerRightsGrant, SourceIngestionFailure>> },
   *   readonly capacity: { readonly reserve: (command: unknown) => Promise<Result<BrowserRunReservation, SourceIngestionFailure>>, readonly reconcile: (command: unknown) => Promise<Result<null, SourceIngestionFailure>> },
   *   readonly acquirer: { readonly acquire: (command: unknown) => Promise<Result<BrowserRunAcquisitionBatch, SourceIngestionFailure>> },
   *   readonly contentStore: { readonly stage: (command: { readonly objectId: string, readonly ownerId: string, readonly sourceId: string, readonly itemId: string, readonly itemVersionId: string, readonly content: Uint8Array, readonly contentDigest: string, readonly mediaType: string }) => Promise<Result<{ readonly objectKey: string }, SourceIngestionFailure>>, readonly remove: (objectKey: string) => Promise<Result<null, SourceIngestionFailure>> },
   *   readonly digest: (content: Uint8Array) => Promise<Result<string, SourceIngestionFailure>>,
   *   readonly generationEnqueue?: (command: unknown) => Promise<Result<unknown, { readonly kind: string }>>,
   *   readonly logger: (entry: { readonly event: string, readonly failureKind?: string, readonly itemCount?: number }) => void,
   *   readonly createId: () => string,
   *   readonly now: () => string,
   *   readonly leaseDurationMs: number
   * }} dependencies */
  constructor(dependencies) {
    if (typeof dependencies?.policy?.assess !== "function" || typeof dependencies.policy.checkBoundary !== "function" ||
      typeof dependencies.repository?.loadRunnable !== "function" || typeof dependencies.repository.lease !== "function" ||
      typeof dependencies.repository.recordMetadataOnly !== "function" || typeof dependencies.repository.commit !== "function" ||
      typeof dependencies.rightsRegistry?.resolve !== "function" || typeof dependencies.capacity?.reserve !== "function" ||
      typeof dependencies.capacity.reconcile !== "function" || typeof dependencies.acquirer?.acquire !== "function" ||
      typeof dependencies.contentStore?.stage !== "function" || typeof dependencies.contentStore.remove !== "function" ||
      typeof dependencies.digest !== "function" || typeof dependencies.createId !== "function" ||
      typeof dependencies.now !== "function" || typeof dependencies.logger !== "function" || !isPositiveInteger(dependencies.leaseDurationMs)) {
      throw new TypeError("Source-ingestion runner dependencies are invalid.");
    }
    this.#dependencies = dependencies;
  }

  /** @param {unknown} command @returns {Promise<Result<{ readonly state: "completed" | "partial", readonly itemsStored: number }, SourceIngestionFailure>>} */
  async run(command) {
    const parsed = validateRunCommand(command);
    if (!parsed.ok) return parsed;
    const loaded = await this.#dependencies.repository.loadRunnable(parsed.value);
    if (!loaded.ok) return loaded;
    const job = loaded.value;
    if (job.ownerId !== parsed.value.ownerId || job.jobId !== parsed.value.jobId) throw new TypeError("Source-ingestion job loader broke its identity contract.");

    const rights = await this.#dependencies.rightsRegistry.resolve(job);
    if (!rights.ok) return await this.#metadataOnly(job, rights);
    const assessment = assessmentFrom(job, rights.value);
    const plan = this.#dependencies.policy.assess(assessment);
    if (!plan.ok) return await this.#metadataOnly(job, plan);

    const reservation = await this.#dependencies.capacity.reserve({ ownerId: job.ownerId, jobId: job.jobId });
    if (!reservation.ok) return reservation;
    const leasedAt = this.#time();
    const lease = freeze({ ownerId: job.ownerId, jobId: job.jobId, sourceId: job.sourceId, sourceRevision: job.sourceRevision, leaseToken: this.#id("lease"), leasedAt, leaseExpiresAt: new Date(Date.parse(leasedAt) + this.#dependencies.leaseDurationMs).toISOString() });
    const leased = await this.#dependencies.repository.lease(lease, JSON.stringify(plan.value), job.cursor);
    if (!leased.ok) {
      const released = await this.#dependencies.capacity.reconcile({ reservation: reservation.value, measuredMilliseconds: 0, outcome: "not-started" });
      return released.ok ? leased : released;
    }

    const acquired = await this.#dependencies.acquirer.acquire({ job, cursor: job.cursor, plan: plan.value, rights: rights.value });
    if (!acquired.ok) {
      const reconciled = await this.#dependencies.capacity.reconcile({ reservation: reservation.value, measuredMilliseconds: 0, outcome: providerMayHaveRun(acquired.error) ? "uncertain" : "not-started" });
      if (!reconciled.ok) return reconciled;
      const partial = await this.#commitEmpty(lease, job.cursor, plan.value, acquired.error.kind);
      return partial.ok ? acquired : partial;
    }

    const processed = await this.#processBatch(lease, plan.value, rights.value, acquired.value, job.cursor);
    if (!processed.ok) {
      const reconciled = await this.#dependencies.capacity.reconcile({ reservation: reservation.value, measuredMilliseconds: acquired.value.measuredMilliseconds, outcome: "partial" });
      if (!reconciled.ok) return reconciled;
      return fail(processed.error);
    }
    const reconciled = await this.#dependencies.capacity.reconcile({ reservation: reservation.value, measuredMilliseconds: acquired.value.measuredMilliseconds, outcome: acquired.value.nextCursor === null ? "completed" : "partial" });
    if (!reconciled.ok) return await this.#cleanup(processed.value.stagedKeys, reconciled);
    const state = acquired.value.nextCursor === null ? /** @type {const} */ ("completed") : /** @type {const} */ ("partial");
    const generationState = this.#dependencies.generationEnqueue !== undefined && processed.value.generationInputs.length > 0 ? /** @type {const} */ ("queued") : /** @type {const} */ ("not-requested");
    const committed = await this.#dependencies.repository.commit({
      lease,
      crawlAssessment: { id: this.#id("crawl"), ownerId: lease.ownerId, sourceId: lease.sourceId, sourceRevision: lease.sourceRevision, policyVersion: plan.value.policyVersion, selectedDepth: plan.value.selectedDepth, evidence: plan.value.depthEvidence === null ? [] : [plan.value.depthEvidence], outcome: state === "completed" ? "eligible" : "partial", assessedAt: plan.value.assessedAt },
      rightsAssessments: processed.value.rightsAssessments,
      items: processed.value.items,
      contentReferences: processed.value.contentReferences,
      state,
      generationState,
      stopReason: acquired.value.stopReason,
      pagesProcessed: (acquired.value.nextCursor ?? terminalCursor(job.cursor, acquired.value)).pagesProcessed,
      decodedBytes: (acquired.value.nextCursor ?? terminalCursor(job.cursor, acquired.value)).decodedBytes,
      resumeCursor: acquired.value.nextCursor,
      committedAt: this.#time(),
    });
    if (!committed.ok) return await this.#cleanup(processed.value.stagedKeys, committed);
    if (this.#dependencies.generationEnqueue !== undefined && processed.value.generationInputs.length > 0) {
      const enqueued = await this.#dependencies.generationEnqueue({ ownerId: lease.ownerId, sourceId: lease.sourceId, sourceRevision: lease.sourceRevision, rightsEvidenceId: rights.value.registryId, attribution: { label: rights.value.attributionText, sourceUrl: processed.value.items[0].canonicalUrl }, items: processed.value.generationInputs });
      if (!enqueued.ok) this.#dependencies.logger({ event: "source-ingestion-generation-enqueue-failure", failureKind: enqueued.error.kind, itemCount: processed.value.generationInputs.length });
      if (this.#dependencies.repository.markGenerationState !== undefined) {
        const marked = await this.#dependencies.repository.markGenerationState({ ownerId: lease.ownerId, jobId: lease.jobId, state: enqueued.ok ? "completed" : "failed", failureKind: enqueued.ok ? null : enqueued.error.kind, updatedAt: this.#time() });
        if (!marked.ok) this.#dependencies.logger({ event: "source-ingestion-generation-state-failure", failureKind: marked.error.kind, itemCount: processed.value.generationInputs.length });
      }
    }
    return { ok: true, value: freeze({ state, itemsStored: processed.value.items.length }) };
  }

  /** @param {SourceIngestionLease} lease @param {import("../src/features/source-library/ingestion-contracts.js").SourceCrawlPlan} plan @param {ServerRightsGrant} grant @param {BrowserRunAcquisitionBatch} batch @param {SourceIngestionCursor} startingCursor @returns {Promise<Result<{ readonly items: readonly SourceItemVersion[], readonly rightsAssessments: readonly SourceRightsAssessment[], readonly contentReferences: readonly SourceContentReference[], readonly generationInputs: readonly { readonly itemId: string, readonly itemVersionId: string, readonly contentDigest: string, readonly content: string }[], readonly stagedKeys: readonly string[] }, SourceIngestionFailure>>} */
  async #processBatch(lease, plan, grant, batch, startingCursor) {
    if (!validBatch(batch)) return fail({ kind: "BrowserRunResponseInvalid", field: "batch" });
    /** @type {SourceItemVersion[]} */ const items = [];
    /** @type {SourceRightsAssessment[]} */ const rightsAssessments = [];
    /** @type {SourceContentReference[]} */ const contentReferences = [];
    /** @type {{ readonly itemId: string, readonly itemVersionId: string, readonly contentDigest: string, readonly content: string }[]} */ const generationInputs = [];
    /** @type {string[]} */ const stagedKeys = [];
    let decodedBytes = startingCursor.decodedBytes;
    for (const page of batch.pages) {
      const bytes = encoder.encode(page.readableText);
      decodedBytes += bytes.byteLength;
      const boundary = this.#dependencies.policy.checkBoundary({ pages: startingCursor.pagesProcessed + items.length + 1, depth: 0, decodedBytes, concurrency: 1, durationMs: batch.measuredMilliseconds, redirects: startingCursor.redirects + page.redirectChain.length });
      if (!boundary.ok) return await this.#cleanup(stagedKeys, boundary);
      const urlDigest = await this.#dependencies.digest(encoder.encode(page.canonicalUrl));
      if (!urlDigest.ok) return await this.#cleanup(stagedKeys, urlDigest);
      const contentDigest = await this.#dependencies.digest(bytes);
      if (!contentDigest.ok) return await this.#cleanup(stagedKeys, contentDigest);
      const itemId = `item:${urlDigest.value}`;
      const versionId = `version:${contentDigest.value}`;
      const rightsId = this.#id("rights");
      const contentId = this.#id("content");
      const staged = await this.#dependencies.contentStore.stage({ objectId: contentId, ownerId: lease.ownerId, sourceId: lease.sourceId, itemId, itemVersionId: versionId, content: bytes, contentDigest: contentDigest.value, mediaType: "text/plain" });
      if (!staged.ok) return await this.#cleanup(stagedKeys, staged);
      stagedKeys.push(staged.value.objectKey);
      items.push(freeze({ ownerId: lease.ownerId, sourceId: lease.sourceId, sourceRevision: lease.sourceRevision, itemId, versionId, canonicalUrl: page.canonicalUrl, title: page.title, description: page.description, contentDigest: contentDigest.value, provenance: freeze([{ method: "cloudflare-browser-run", reference: page.canonicalUrl }, { method: "rights-registry", reference: grant.registryId }]), observedAt: page.observedAt, publishedAt: null }));
      rightsAssessments.push(freeze({ id: rightsId, ownerId: lease.ownerId, sourceId: lease.sourceId, sourceRevision: lease.sourceRevision, itemId, itemVersionId: versionId, capabilities: freeze(Object.entries(grant.capabilities).map(([capability, evidence]) => freeze({ capability, outcome: evidence.outcome }))), evidence: freeze(Object.values(grant.capabilities).map((evidence) => freeze({ reference: evidence.evidenceReference, observedAt: evidence.observedAt }))), assessedAt: plan.assessedAt, expiresAt: grant.expiresAt }));
      contentReferences.push(freeze({ id: contentId, ownerId: lease.ownerId, sourceId: lease.sourceId, sourceRevision: lease.sourceRevision, itemId, itemVersionId: versionId, objectKey: staged.value.objectKey, contentDigest: contentDigest.value, rightsAssessmentId: rightsId, state: /** @type {const} */ ("processing-ready"), createdAt: page.observedAt }));
      generationInputs.push(freeze({ itemId, itemVersionId: versionId, contentDigest: contentDigest.value, content: page.readableText }));
    }
    return { ok: true, value: freeze({ items: freeze(items), rightsAssessments: freeze(rightsAssessments), contentReferences: freeze(contentReferences), generationInputs: freeze(generationInputs), stagedKeys: freeze(stagedKeys) }) };
  }

  /** @param {SourceIngestionLease} lease @param {SourceIngestionCursor} cursor @param {import("../src/features/source-library/ingestion-contracts.js").SourceCrawlPlan} plan @param {string} stopReason */
  async #commitEmpty(lease, cursor, plan, stopReason) {
    return this.#dependencies.repository.commit({ lease, crawlAssessment: { id: this.#id("crawl"), ownerId: lease.ownerId, sourceId: lease.sourceId, sourceRevision: lease.sourceRevision, policyVersion: plan.policyVersion, selectedDepth: plan.selectedDepth, evidence: plan.depthEvidence === null ? [] : [plan.depthEvidence], outcome: "partial", assessedAt: plan.assessedAt }, rightsAssessments: [], items: [], contentReferences: [], state: "partial", generationState: "not-requested", stopReason, pagesProcessed: cursor.pagesProcessed, decodedBytes: cursor.decodedBytes, resumeCursor: cursor, committedAt: this.#time() });
  }

  /** @template T @param {TrustedSourceIngestionJob} job @param {Result<T, SourceIngestionFailure>} failure */
  async #metadataOnly(job, failure) {
    if (failure.ok) throw new TypeError("Metadata-only persistence requires a failure.");
    const recorded = await this.#dependencies.repository.recordMetadataOnly(job, failure.error.kind, this.#time());
    return recorded.ok ? failure : recorded;
  }

  /** @template T @param {readonly string[]} keys @param {Result<T, SourceIngestionFailure>} failure @returns {Promise<Result<never, SourceIngestionFailure>>} */
  async #cleanup(keys, failure) {
    if (failure.ok) throw new TypeError("Cleanup requires a failure.");
    for (const key of keys) {
      const removed = await this.#dependencies.contentStore.remove(key);
      if (!removed.ok) return fail(removed.error);
    }
    return fail(failure.error);
  }

  #time() { const value = this.#dependencies.now(); if (!isIsoDateTime(value)) throw new TypeError("Source-ingestion clock returned an invalid time."); return value; }
  /** @param {string} prefix */
  #id(prefix) { const value = this.#dependencies.createId(); if (!isNonEmptyText(value)) throw new TypeError("Source-ingestion ID factory returned an invalid ID."); return `${prefix}:${value}`; }
}

/** @param {TrustedSourceIngestionJob} job @param {ServerRightsGrant} grant @returns {SourcePolicyAssessmentCommand} */
function assessmentFrom(job, grant) {
  if (grant.ownerId !== job.ownerId || grant.sourceId !== job.sourceId || grant.sourceRevision !== job.sourceRevision || grant.canonicalRootUrl !== new URL(job.rootUrl).href) throw new TypeError("Rights registry broke its identity contract.");
  return freeze({ ownerId: job.ownerId, sourceId: job.sourceId, sourceRevision: job.sourceRevision, rootUrl: job.rootUrl, robots: grant.crawlEvidence.robots, robotsEvidenceReference: grant.crawlEvidence.robotsEvidenceReference, terms: grant.crawlEvidence.terms, termsEvidenceReference: grant.crawlEvidence.termsEvidenceReference, access: grant.crawlEvidence.access, accessEvidenceReference: grant.crawlEvidence.accessEvidenceReference, rights: grant.capabilities, structuralEvidence: grant.crawlEvidence.structuralEvidence });
}

/** @param {SourceIngestionCursor} cursor @param {BrowserRunAcquisitionBatch} batch */
function terminalCursor(cursor, batch) { return { ...cursor, pagesProcessed: cursor.pagesProcessed + batch.pages.length, decodedBytes: cursor.decodedBytes + batch.pages.reduce((total, page) => total + encoder.encode(page.readableText).byteLength, 0) }; }

/** @param {unknown} value */
function validBatch(value) { return isRecord(value) && Array.isArray(value.pages) && value.pages.every((page) => isRecord(page) && isPublicHttpsUrl(page.canonicalUrl) && Number.isInteger(page.status) && isNonEmptyText(page.title) && typeof page.description === "string" && isNonEmptyText(page.readableText) && Array.isArray(page.visibleLinks) && Array.isArray(page.redirectChain) && isNonEmptyText(page.peerAddress) && isIsoDateTime(page.observedAt)) && (value.nextCursor === null || isRecord(value.nextCursor)) && typeof value.measuredMilliseconds === "number" && Number.isInteger(value.measuredMilliseconds) && value.measuredMilliseconds >= 0 && (value.stopReason === null || isNonEmptyText(value.stopReason)); }
/** @param {SourceIngestionFailure} failure */
function providerMayHaveRun(failure) { return !["BrowserRunBindingInvalid", "BrowserRunConfigurationInvalid", "BrowserRunDailyBudgetExceeded", "BrowserRunConcurrencyExceeded", "BrowserRunLaunchThrottled", "RightsRegistryEvidenceConflicting"].includes(failure.kind); }

/** @param {unknown} value @returns {Result<{ readonly ownerId: string, readonly jobId: string }, SourceIngestionFailure>} */
function validateRunCommand(value) { return !isRecord(value) || !isNonEmptyText(value.ownerId) || !isNonEmptyText(value.jobId) || Object.keys(value).some((field) => field !== "ownerId" && field !== "jobId") ? fail({ kind: "SourceIngestionCommandInvalid", field: "command" }) : { ok: true, value: freeze({ ownerId: value.ownerId.trim(), jobId: value.jobId.trim() }) }; }
/** @param {SourceIngestionFailure} error @returns {Result<never, SourceIngestionFailure>} */
function fail(error) { return { ok: false, error }; }

export {};
