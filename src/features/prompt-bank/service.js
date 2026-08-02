// @ts-check

import { adaptiveYield, classifyLength } from "./policy.js";

/** @import { ContentExtentEvidence, ContentExtentPolicy, GeneratedPrompt, PromptBankFailure, PromptClock, PromptEventWriter, PromptGenerationEvent, PromptGenerator, PromptStudyFact, Result } from "./contracts.js" */
/** @import { PromptBankRepository } from "./repository.js" */

const TEN_MINUTES_MS = 10 * 60_000;

export class PromptBankService {
  /** @type {PromptBankRepository} */
  #repository;
  /** @type {ContentExtentPolicy} */
  #policy;
  /** @type {PromptGenerator} */
  #generator;
  /** @type {PromptClock} */
  #clock;
  /** @type {PromptEventWriter} */
  #writer;
  /** @type {() => string} */
  #createId;

  /**
   * @param {{
   *   readonly repository: PromptBankRepository,
   *   readonly policy: ContentExtentPolicy,
   *   readonly generator: PromptGenerator,
   *   readonly clock: PromptClock,
   *   readonly writer: PromptEventWriter,
   *   readonly createId: () => string
   * }} dependencies
   */
  constructor(dependencies) {
    if (
      !dependencies || typeof dependencies.generator?.generate !== "function" ||
      typeof dependencies.clock?.now !== "function" ||
      typeof dependencies.writer !== "function" ||
      typeof dependencies.createId !== "function"
    ) {
      throw new TypeError("PromptBankDependenciesInvalid");
    }
    this.#repository = dependencies.repository;
    this.#policy = dependencies.policy;
    this.#generator = dependencies.generator;
    this.#clock = dependencies.clock;
    this.#writer = dependencies.writer;
    this.#createId = dependencies.createId;
  }

  /**
   * @param {{
   *   readonly ownerId: string,
   *   readonly contentId: string,
   *   readonly contentVersion: number,
   *   readonly evidence: ContentExtentEvidence,
   *   readonly studyFact: PromptStudyFact | null,
   *   readonly idempotencyKey: string
   * }} command
   * @returns {Promise<Result<PromptGenerationEvent, PromptBankFailure>>}
   */
  async generate(command) {
    if (command.studyFact === null) {
      return {
        ok: false,
        error: {
          kind: "PromptSourceNotStudied",
          contentId: command.contentId,
        },
      };
    }
    if (
      command.ownerId !== command.studyFact.ownerId ||
      command.ownerId !== command.evidence.ownerId
    ) {
      return {
        ok: false,
        error: {
          kind: "PromptSourceOwnerMismatch",
          ownerId: command.ownerId,
        },
      };
    }
    if (command.contentVersion !== command.studyFact.contentVersion) {
      return {
        ok: false,
        error: {
          kind: "PromptSourceVersionMismatch",
          expected: command.contentVersion,
          actual: command.studyFact.contentVersion,
        },
      };
    }
    if (command.contentVersion !== command.evidence.contentVersion) {
      return {
        ok: false,
        error: {
          kind: "MaterialLengthVersionMismatch",
          expected: command.contentVersion,
          actual: command.evidence.contentVersion,
        },
      };
    }
    const classified = classifyLength(command.evidence, this.#policy);
    if (!classified.ok) return classified;
    /** @type {Set<string>} */
    const anchorIds = new Set();
    for (const anchor of command.evidence.anchors) {
      anchorIds.add(anchor.id);
    }
    const yieldResult = adaptiveYield(classified.value, anchorIds.size);
    if (!yieldResult.ok) return yieldResult;
    const nowResult = this.#clock.now();
    if (!nowResult.ok) return nowResult;
    const nowMs = Date.parse(nowResult.value);
    const studiedMs = Date.parse(command.studyFact.studiedAt);
    if (!Number.isFinite(nowMs)) {
      return {
        ok: false,
        error: {
          kind: "ClockInstantInvalid",
          instant: nowResult.value,
        },
      };
    }
    if (!Number.isFinite(studiedMs)) {
      return {
        ok: false,
        error: {
          kind: "ClockInstantInvalid",
          instant: command.studyFact.studiedAt,
        },
      };
    }
    if (nowMs < studiedMs) {
      return {
        ok: false,
        error: {
          kind: "ClockRegressionDetected",
          studiedAt: command.studyFact.studiedAt,
          now: nowResult.value,
        },
      };
    }
    const eligibleAt = new Date(studiedMs + TEN_MINUTES_MS).toISOString();
    if (nowMs < Date.parse(eligibleAt)) {
      return {
        ok: false,
        error: { kind: "PromptGenerationTooEarly", eligibleAt },
      };
    }
    const generated = this.#generator.generate({
      evidence: command.evidence,
      band: classified.value,
      count: yieldResult.value,
      generatedAt: nowResult.value,
      eligibleAt,
      policyVersion: this.#policy.version,
    });
    const outputValidation = validateGenerated(
      generated,
      command,
      anchorIds,
      yieldResult.value,
      this.#generator.version,
      this.#policy.version,
    );
    if (!outputValidation.ok) return outputValidation;
    /** @type {PromptGenerationEvent} */
    const event = Object.freeze({
      id: this.#createId(),
      ownerId: command.ownerId,
      contentId: command.contentId,
      contentVersion: command.contentVersion,
      band: classified.value,
      prompts: Object.freeze([...outputValidation.value]),
      generationSequence: this.#repository.listEvents(command.ownerId).length +
        1,
      idempotencyKey: command.idempotencyKey,
      generatedAt: nowResult.value,
      eligibleAt,
      evidenceVersion: command.evidence.evidenceVersion,
      policyVersion: this.#policy.version,
      generatorVersion: this.#generator.version,
    });
    const persisted = await this.#writer(event);
    if (!persisted.ok) {
      return {
        ok: false,
        error: {
          kind: "PromptGenerationPersistenceFailed",
          recordId: event.id,
        },
      };
    }
    return this.#repository.record(event);
  }
}

/**
 * @param {readonly GeneratedPrompt[]} prompts
 * @param {{ readonly ownerId: string, readonly contentId: string, readonly contentVersion: number }} command
 * @param {ReadonlySet<string>} anchorIds
 * @param {number} count
 * @param {string} generatorVersion
 * @param {string} policyVersion
 * @returns {Result<readonly GeneratedPrompt[], PromptBankFailure>}
 */
function validateGenerated(
  prompts,
  command,
  anchorIds,
  count,
  generatorVersion,
  policyVersion,
) {
  if (prompts.length !== count) return invalidOutput("count");
  const promptIds = new Set();
  for (const prompt of prompts) {
    if (
      prompt.id.trim() === "" || promptIds.has(prompt.id) ||
      prompt.ownerId !== command.ownerId ||
      prompt.contentId !== command.contentId ||
      prompt.contentVersion !== command.contentVersion ||
      prompt.prompt.trim() === "" ||
      prompt.version < 1 ||
      prompt.generatorVersion !== generatorVersion ||
      prompt.policyVersion !== policyVersion ||
      prompt.knowledgeAnchorIds.length === 0 ||
      !anchorsBelong(prompt.knowledgeAnchorIds, anchorIds)
    ) {
      return invalidOutput("prompt");
    }
    promptIds.add(prompt.id);
  }
  return { ok: true, value: Object.freeze([...prompts]) };
}

/** @param {string} reason @returns {Result<never, PromptBankFailure>} */
function invalidOutput(reason) {
  return {
    ok: false,
    error: { kind: "PromptGenerationOutputInvalid", reason },
  };
}

/**
 * @param {readonly string[]} ids
 * @param {ReadonlySet<string>} available
 */
function anchorsBelong(ids, available) {
  for (const id of ids) {
    if (!available.has(id)) return false;
  }
  return true;
}
