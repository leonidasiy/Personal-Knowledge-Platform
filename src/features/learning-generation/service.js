// @ts-check

import {
  isNonEmptyText,
  isPositiveInteger,
  isRecord,
} from "./contracts.js";
import { unitize } from "./unitization.js";
import { validateDrafts } from "./validation.js";

/** @import { LearningCostModel, LearningGenerationCommand, LearningGenerationFailure, LearningGenerationPolicy, LearningGenerationRecord, LearningGenerationRepositoryPort, LearningLogger, LearningProviderCommand, LearningProviderFailure, LearningProviderResult, LearningRightsGrant, Result } from "./contracts.js" */

/** @typedef {{ readonly generate: (command: LearningProviderCommand) => Promise<Result<LearningProviderResult, LearningProviderFailure>> }} LearningProviderPort */

const freeze = Object.freeze;

export class LearningGenerationService {
  #repository;
  #provider;
  #budget;
  #costModel;
  #createId;
  #now;
  #logger;

  /** @param {{ readonly repository: LearningGenerationRepositoryPort, readonly provider: LearningProviderPort, readonly budget: import("./contracts.js").LearningBudgetPort, readonly costModel: LearningCostModel, readonly createId: () => string, readonly now: () => string, readonly logger: LearningLogger }} dependencies */
  constructor(dependencies) {
    if (
      typeof dependencies?.repository?.replay !== "function" ||
      typeof dependencies.repository.persist !== "function" ||
      typeof dependencies.repository.assertGenerationAllowed !== "function" ||
      typeof dependencies.provider?.generate !== "function" ||
      typeof dependencies.budget?.reserve !== "function" ||
      typeof dependencies.budget.reconcile !== "function" ||
      typeof dependencies.costModel?.estimate !== "function" ||
      typeof dependencies.costModel.actual !== "function" ||
      typeof dependencies.createId !== "function" ||
      typeof dependencies.now !== "function" ||
      typeof dependencies.logger !== "function"
    ) {
      throw new TypeError("Learning-generation dependencies are invalid.");
    }
    this.#repository = dependencies.repository;
    this.#provider = dependencies.provider;
    this.#budget = dependencies.budget;
    this.#costModel = dependencies.costModel;
    this.#createId = dependencies.createId;
    this.#now = dependencies.now;
    this.#logger = dependencies.logger;
  }

  /** @param {unknown} input @returns {Promise<Result<LearningGenerationRecord, LearningGenerationFailure>>} */
  async generate(input) {
    const now = this.#now();
    if (!isIsoDateTime(now)) throw new TypeError("Learning-generation clock returned an invalid time.");
    const command = validateCommand(input, now);
    if (!command.ok) return this.#fail(command.error);
    this.#logger({ event: "learning-generation-entry" });
    const allowed = await this.#repository.assertGenerationAllowed(command.value.ownerId, command.value.sourceId, command.value.sourceRevision);
    if (!allowed.ok) return this.#fail(allowed.error);
    const fingerprint = fingerprintOf(command.value);
    const replay = await this.#repository.replay(command.value.ownerId, command.value.idempotencyKey);
    if (!replay.ok) return this.#fail(replay.error);
    if (replay.value !== null) {
      if (replay.value.fingerprint !== fingerprint) {
        return this.#fail({ kind: "LearningGenerationIdempotencyConflict", idempotencyKey: command.value.idempotencyKey });
      }
      this.#logger({ event: "learning-generation-replay" });
      return { ok: true, value: replay.value.record };
    }

    const units = unitize({
      ownerId: command.value.ownerId,
      sourceId: command.value.sourceId,
      sourceRevision: command.value.sourceRevision,
      itemId: command.value.itemId,
      itemVersionId: command.value.itemVersionId,
      contentDigest: command.value.contentDigest,
      sourceKind: command.value.sourceKind,
      content: command.value.content,
      policy: command.value.policy.unitization,
    });
    if (!units.ok) return this.#fail(units.error);

    if (command.value.sourceKind === "manual-transcript") {
      const record = this.#record(command.value, units.value.units, [], true, null, null, "completed", now);
      return this.#persist(record, fingerprint);
    }

    const excerpt = selectProviderExcerpt(units.value.units, command.value.policy);
    if (!excerpt.ok) return this.#fail(excerpt.error);
    const estimatedUsd = this.#costModel.estimate({
      inputCharacters: excerpt.value.text.length,
      maximumOutputTokens: command.value.policy.maximumOutputTokens,
    });
    if (!Number.isFinite(estimatedUsd) || estimatedUsd < 0 || estimatedUsd > command.value.policy.monthlyBudgetUsd) {
      return this.#fail({ kind: "LearningBudgetEstimateInvalid" });
    }
    const reserved = await this.#budget.reserve({
      ownerId: command.value.ownerId,
      idempotencyKey: command.value.idempotencyKey,
      month: now.slice(0, 7),
      amountUsd: estimatedUsd,
      capUsd: command.value.policy.monthlyBudgetUsd,
    });
    if (!reserved.ok) return this.#fail(reserved.error);
    const provider = await this.#provider.generate({
      sourceKind: command.value.sourceKind,
      excerpt: excerpt.value.text,
      unitIds: excerpt.value.unitIds,
      sourceAnchorIds: excerpt.value.sourceAnchorIds,
      instruction: command.value.policy.providerInstruction,
      maximumOutputTokens: command.value.policy.maximumOutputTokens,
    });
    if (!provider.ok) {
      const reconciled = await this.#budget.reconcile({ reservation: reserved.value, actualUsd: null, outcome: "failed" });
      if (!reconciled.ok) return this.#fail({ kind: "LearningBudgetReconciliationFailed" });
      const record = this.#record(command.value, units.value.units, [], false, null, provider.error.kind, "failed", now);
      const persisted = await this.#persist(record, fingerprint);
      return persisted.ok ? this.#fail(provider.error) : persisted;
    }
    const actualUsd = this.#costModel.actual(provider.value.usage);
    if (!Number.isFinite(actualUsd) || actualUsd < 0) {
      return this.#fail({ kind: "LearningBudgetEstimateInvalid" });
    }
    const reconciled = await this.#budget.reconcile({ reservation: reserved.value, actualUsd, outcome: "completed" });
    if (!reconciled.ok) return this.#fail({ kind: "LearningBudgetReconciliationFailed" });
    if (provider.value.drafts.length > command.value.policy.maximumTasks) {
      const failure = /** @type {LearningGenerationFailure} */ ({ kind: "LearningDraftSchemaInvalid", field: "task-count" });
      const record = this.#record(command.value, units.value.units, [], false, provider.value.requestId, failure.kind, "failed", now);
      const persisted = await this.#persist(record, fingerprint);
      return persisted.ok ? this.#fail(failure) : persisted;
    }
    const validated = validateDrafts(provider.value.drafts, {
      ownerId: command.value.ownerId,
      sourceId: command.value.sourceId,
      sourceRevision: command.value.sourceRevision,
      itemId: command.value.itemId,
      itemVersionId: command.value.itemVersionId,
      contentDigest: command.value.contentDigest,
      generatorVersion: "deepseek-v4-flash-adapter-v1",
      policyVersion: command.value.policy.version,
      samplingVersion: command.value.policy.samplingVersion,
      factualSamplingRatePercent: command.value.policy.factualSamplingRatePercent,
      generatedAt: now,
      units: units.value.units,
    });
    if (!validated.ok) {
      const record = this.#record(command.value, units.value.units, [], false, provider.value.requestId, validated.error.kind, "failed", now);
      const persisted = await this.#persist(record, fingerprint);
      return persisted.ok ? this.#fail(validated.error) : persisted;
    }
    const record = this.#record(command.value, units.value.units, validated.value, false, provider.value.requestId, null, "completed", now);
    return this.#persist(record, fingerprint);
  }

  /** @param {LearningGenerationCommand} command @param {readonly import("./contracts.js").LearningUnit[]} units @param {readonly import("./contracts.js").LearningTask[]} tasks @param {boolean} localOnly @param {string|null} providerRequestId @param {string|null} failureKind @param {"completed"|"failed"|"revoked"} status @param {string} createdAt @returns {LearningGenerationRecord} */
  #record(command, units, tasks, localOnly, providerRequestId, failureKind, status, createdAt) {
    const id = this.#createId();
    if (!isNonEmptyText(id)) throw new TypeError("Learning-generation ID factory returned an invalid ID.");
    return freeze({
      id,
      ownerId: command.ownerId,
      sourceId: command.sourceId,
      sourceRevision: command.sourceRevision,
      itemId: command.itemId,
      itemVersionId: command.itemVersionId,
      contentDigest: command.contentDigest,
      sourceKind: command.sourceKind,
      rightsEvidenceId: command.rights.evidenceId,
      attribution: command.rights.kind === "public" ? command.rights.attribution : null,
      policyVersion: command.policy.version,
      units: freeze([...units]),
      tasks: freeze([...tasks]),
      status,
      localOnly,
      providerRequestId,
      failureKind,
      idempotencyKey: command.idempotencyKey,
      createdAt,
    });
  }

  /** @param {LearningGenerationRecord} record @param {string} fingerprint @returns {Promise<Result<LearningGenerationRecord, LearningGenerationFailure>>} */
  async #persist(record, fingerprint) {
    const persisted = await this.#repository.persist(record, fingerprint);
    if (!persisted.ok) return this.#fail({ kind: "LearningGenerationPersistenceFailed" });
    this.#logger({ event: "learning-generation-success" });
    return persisted;
  }

  /** @param {LearningGenerationFailure} failure @returns {Result<never, LearningGenerationFailure>} */
  #fail(failure) {
    this.#logger({ event: "learning-generation-failure", failureKind: failure.kind });
    return { ok: false, error: failure };
  }
}

/** @param {unknown} value @param {string} now @returns {Result<LearningGenerationCommand, LearningGenerationFailure>} */
function validateCommand(value, now) {
  if (!isRecord(value)) return invalidCommand("command");
  for (const field of ["ownerId", "sourceId", "itemId", "itemVersionId", "contentDigest", "idempotencyKey"]) {
    if (!isNonEmptyText(value[field])) return invalidCommand(field);
  }
  if (typeof value.content !== "string") return invalidCommand("content");
  if (!isPositiveInteger(value.sourceRevision)) return invalidCommand("sourceRevision");
  if (value.sourceKind !== "public-text" && value.sourceKind !== "manual-transcript") return invalidCommand("sourceKind");
  const policy = validatePolicy(value.policy);
  if (!policy.ok) return policy;
  const rights = validateRights(value.rights);
  if (!rights.ok) return rights;
  const checked = /** @type {{ readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly itemId: string, readonly itemVersionId: string, readonly contentDigest: string, readonly content: string, readonly idempotencyKey: string, readonly sourceKind: "public-text" | "manual-transcript", readonly rights: LearningRightsGrant }} */ (value);
  if (rights.value.ownerId !== checked.ownerId) return { ok: false, error: { kind: "LearningOwnerMismatch" } };
  if (rights.value.sourceId !== checked.sourceId) return { ok: false, error: { kind: "LearningSourceMismatch" } };
  if (rights.value.sourceRevision !== checked.sourceRevision) return { ok: false, error: { kind: "LearningSourceRevisionStale", expected: checked.sourceRevision, actual: rights.value.sourceRevision } };
  if (rights.value.status === "revoked") return { ok: false, error: { kind: "LearningRightsRevoked" } };
  if (rights.value.expiresAt !== null && Date.parse(rights.value.expiresAt) <= Date.parse(now)) return { ok: false, error: { kind: "LearningRightsExpired", expiresAt: rights.value.expiresAt } };
  if (checked.sourceKind === "public-text" && rights.value.kind !== "public") return { ok: false, error: { kind: "LearningRightsMissing" } };
  if (checked.sourceKind === "manual-transcript" && rights.value.kind !== "manual") return { ok: false, error: { kind: "LearningRightsMissing" } };
  return {
    ok: true,
    value: freeze(/** @type {LearningGenerationCommand} */ ({
      ownerId: checked.ownerId.trim(),
      sourceId: checked.sourceId.trim(),
      sourceRevision: checked.sourceRevision,
      itemId: checked.itemId.trim(),
      itemVersionId: checked.itemVersionId.trim(),
      contentDigest: checked.contentDigest.trim(),
      sourceKind: checked.sourceKind,
      content: checked.content,
      rights: rights.value,
      idempotencyKey: checked.idempotencyKey.trim(),
      policy: policy.value,
    })),
  };
}

/** @param {unknown} value @returns {Result<LearningGenerationPolicy, LearningGenerationFailure>} */
function validatePolicy(value) {
  if (!isRecord(value)) return invalidPolicy("policy");
  for (const field of ["version", "samplingVersion", "providerInstruction"]) if (!isNonEmptyText(value[field])) return invalidPolicy(field);
  for (const field of ["maximumProviderInputCharacters", "maximumProviderUnits", "maximumTasks", "maximumOutputTokens"]) if (!isPositiveInteger(value[field])) return invalidPolicy(field);
  if (typeof value.factualSamplingRatePercent !== "number" || !Number.isInteger(value.factualSamplingRatePercent) || value.factualSamplingRatePercent < 0 || value.factualSamplingRatePercent > 100) return invalidPolicy("factualSamplingRatePercent");
  if (typeof value.monthlyBudgetUsd !== "number" || !Number.isFinite(value.monthlyBudgetUsd) || value.monthlyBudgetUsd <= 0 || value.monthlyBudgetUsd > 2) return invalidPolicy("monthlyBudgetUsd");
  const unitization = value.unitization;
  if (!isRecord(unitization) || !isNonEmptyText(unitization.version) || !isPositiveInteger(unitization.maximumContentCharacters) || !isPositiveInteger(unitization.maximumWordsPerUnit) || !isPositiveInteger(unitization.maximumUnits) || !isPositiveInteger(unitization.maximumExcerptCharacters)) return invalidPolicy("unitization");
  const checked = /** @type {{ readonly version: string, readonly unitization: { readonly version: string, readonly maximumContentCharacters: number, readonly maximumWordsPerUnit: number, readonly maximumUnits: number, readonly maximumExcerptCharacters: number }, readonly maximumProviderInputCharacters: number, readonly maximumProviderUnits: number, readonly maximumTasks: number, readonly maximumOutputTokens: number, readonly factualSamplingRatePercent: number, readonly samplingVersion: string, readonly providerInstruction: string, readonly monthlyBudgetUsd: number }} */ (value);
  const checkedUnitization = /** @type {{ readonly version: string, readonly maximumContentCharacters: number, readonly maximumWordsPerUnit: number, readonly maximumUnits: number, readonly maximumExcerptCharacters: number }} */ (unitization);
  return { ok: true, value: freeze(/** @type {LearningGenerationPolicy} */ ({
    version: checked.version.trim(),
    unitization: freeze({ version: checkedUnitization.version.trim(), maximumContentCharacters: checkedUnitization.maximumContentCharacters, maximumWordsPerUnit: checkedUnitization.maximumWordsPerUnit, maximumUnits: checkedUnitization.maximumUnits, maximumExcerptCharacters: checkedUnitization.maximumExcerptCharacters }),
    maximumProviderInputCharacters: checked.maximumProviderInputCharacters,
    maximumProviderUnits: checked.maximumProviderUnits,
    maximumTasks: checked.maximumTasks,
    maximumOutputTokens: checked.maximumOutputTokens,
    factualSamplingRatePercent: checked.factualSamplingRatePercent,
    samplingVersion: checked.samplingVersion.trim(),
    providerInstruction: checked.providerInstruction.trim(),
    monthlyBudgetUsd: checked.monthlyBudgetUsd,
  })) };
}

/** @param {unknown} value @returns {Result<LearningRightsGrant, LearningGenerationFailure>} */
function validateRights(value) {
  if (!isRecord(value)) return { ok: false, error: { kind: "LearningRightsMissing" } };
  for (const field of ["ownerId", "sourceId", "evidenceId", "assessedAt"]) if (!isNonEmptyText(value[field])) return { ok: false, error: { kind: "LearningRightsMissing" } };
  if (!isPositiveInteger(value.sourceRevision) || (value.status !== "active" && value.status !== "revoked")) return { ok: false, error: { kind: "LearningRightsMissing" } };
  const checked = /** @type {{ readonly kind: "public" | "manual", readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly evidenceId: string, readonly status: "active" | "revoked", readonly storageAllowed: boolean, readonly displayAllowed: boolean, readonly transformationAllowed: boolean, readonly assessedAt: string, readonly expiresAt: string | null, readonly attribution: unknown, readonly attestationReference: unknown, readonly attestationBasis: unknown }} */ (value);
  if (!isIsoDateTime(checked.assessedAt) || (checked.expiresAt !== null && !isIsoDateTime(checked.expiresAt))) return { ok: false, error: { kind: "LearningRightsMissing" } };
  if (checked.kind === "public") {
    if (checked.storageAllowed !== true || checked.displayAllowed !== true || checked.transformationAllowed !== true || !isRecord(checked.attribution) || !isNonEmptyText(checked.attribution.label) || !isPublicHttps(checked.attribution.sourceUrl)) return { ok: false, error: { kind: "LearningRightsMissing" } };
    const attribution = /** @type {{ readonly label: string, readonly sourceUrl: string }} */ (checked.attribution);
    return { ok: true, value: freeze(/** @type {LearningRightsGrant} */ ({ kind: "public", ownerId: checked.ownerId.trim(), sourceId: checked.sourceId.trim(), sourceRevision: checked.sourceRevision, evidenceId: checked.evidenceId.trim(), status: checked.status, storageAllowed: true, displayAllowed: true, transformationAllowed: true, assessedAt: checked.assessedAt, expiresAt: checked.expiresAt, attribution: freeze({ label: attribution.label.trim(), sourceUrl: new URL(attribution.sourceUrl).href }) })) };
  }
  if (checked.kind === "manual") {
    if (checked.storageAllowed !== true || checked.transformationAllowed !== true || !isNonEmptyText(checked.attestationReference) || !isNonEmptyText(checked.attestationBasis)) return { ok: false, error: { kind: "LearningRightsMissing" } };
    const attestationReference = /** @type {string} */ (checked.attestationReference);
    const attestationBasis = /** @type {string} */ (checked.attestationBasis);
    return { ok: true, value: freeze(/** @type {LearningRightsGrant} */ ({ kind: "manual", ownerId: checked.ownerId.trim(), sourceId: checked.sourceId.trim(), sourceRevision: checked.sourceRevision, evidenceId: checked.evidenceId.trim(), status: checked.status, storageAllowed: true, transformationAllowed: true, attestationReference: attestationReference.trim(), attestationBasis: attestationBasis.trim(), assessedAt: checked.assessedAt, expiresAt: checked.expiresAt })) };
  }
  return { ok: false, error: { kind: "LearningRightsMissing" } };
}

/** @param {readonly import("./contracts.js").LearningUnit[]} units @param {LearningGenerationPolicy} policy @returns {Result<{ readonly text: string, readonly unitIds: readonly [string, ...string[]], readonly sourceAnchorIds: readonly [string, ...string[]] }, LearningGenerationFailure>} */
function selectProviderExcerpt(units, policy) {
  /** @type {import("./contracts.js").LearningUnit[]} */
  const selected = [];
  let length = 0;
  for (const unit of units) {
    if (selected.length >= policy.maximumProviderUnits) break;
    const nextLength = length === 0 ? unit.text.length : length + 2 + unit.text.length;
    if (nextLength > policy.maximumProviderInputCharacters) break;
    selected.push(unit);
    length = nextLength;
  }
  if (selected.length === 0) return { ok: false, error: { kind: "LearningProviderInputLimitExceeded", maximum: policy.maximumProviderInputCharacters, actual: units[0]?.text.length ?? 0 } };
  const unitIds = /** @type {[string, ...string[]]} */ (selected.map((unit) => unit.id));
  const sourceAnchorIds = /** @type {[string, ...string[]]} */ (selected.flatMap((unit) => unit.sourceAnchorIds));
  return { ok: true, value: freeze({ text: selected.map((unit) => unit.text).join("\n\n"), unitIds: freeze(unitIds), sourceAnchorIds: freeze(sourceAnchorIds) }) };
}

/** @param {LearningGenerationCommand} command */
function fingerprintOf(command) {
  return JSON.stringify([command.ownerId, command.sourceId, command.sourceRevision, command.itemId, command.itemVersionId, command.contentDigest, command.sourceKind, command.policy.version, command.rights.evidenceId]);
}

/** @param {string} value */
function isIsoDateTime(value) { return isNonEmptyText(value) && Number.isFinite(Date.parse(value)); }
/** @param {unknown} value */
function isPublicHttps(value) { if (!isNonEmptyText(value) || !URL.canParse(value)) return false; const url = new URL(value); return url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === ""; }
/** @param {string} field @returns {Result<never, LearningGenerationFailure>} */
function invalidCommand(field) { return { ok: false, error: { kind: "LearningGenerationCommandInvalid", field } }; }
/** @param {string} field @returns {Result<never, LearningGenerationFailure>} */
function invalidPolicy(field) { return { ok: false, error: { kind: "LearningGenerationPolicyInvalid", field } }; }

export {};
