// @ts-check

const freeze = Object.freeze;

import { PromptBankRepository } from "./repository.js";
import { PromptBankService } from "./service.js";

/** @import { CatalogCandidate } from "../catalog/contracts.js" */
/** @import { PromptGenerationEvent, PromptGenerationInput, Result } from "./contracts.js" */
/** @import { PersistenceFailure } from "../../persistence/contracts.js" */

const POLICY = freeze({
  shortMaxWords: 100,
  shortMaxSentences: 2,
  mediumMaxWords: 400,
  mediumMaxParagraphs: 2,
  maxUnitWords: 800,
  maxSegmentsPerCommand: 4,
  version: "content-extent-v1",
});

export class FixturePromptRuntime {
  /** @type {PromptBankRepository} */
  #repository = new PromptBankRepository();
  /** @type {PromptBankService} */
  #service;
  /** @type {ReadonlyMap<string, CatalogCandidate>} */
  #candidates;
  /** @type {string} */
  #ownerId;

  /**
   * @param {{
   *   readonly candidates: readonly CatalogCandidate[],
   *   readonly ownerId: string,
   *   readonly now: () => string,
   *   readonly write: (event: PromptGenerationEvent) => Promise<Result<true, PersistenceFailure>>
   * }} dependencies
   */
  constructor(dependencies) {
    this.#ownerId = dependencies.ownerId;
    this.#candidates = new Map(
      dependencies.candidates.map((candidate) => [candidate.id, candidate]),
    );
    this.#service = new PromptBankService({
      repository: this.#repository,
      policy: POLICY,
      clock: {
        now: () => {
          const instant = dependencies.now();
          return Number.isFinite(Date.parse(instant))
            ? { ok: true, value: instant }
            : { ok: false, error: { kind: "ClockInstantInvalid", instant } };
        },
      },
      writer: async (/** @type {PromptGenerationEvent} */ event) => {
        const result = await dependencies.write(event);
        return result.ok ? { ok: true, value: /** @type {const} */ (true) } : {
          ok: false,
          error: {
            kind: /** @type {const} */ (
              "PromptGenerationPersistenceFailed"
            ),
            recordId: event.id,
          },
        };
      },
      generator: {
        version: "fixture-generator-v2",
        generate: (/** @type {PromptGenerationInput} */ input) => {
          const candidate = this.#candidates.get(input.evidence.contentId);
          if (candidate === undefined) return freeze([]);
          return freeze(
            Array.from({ length: input.count }, (_, index) =>
              freeze({
                id: index === 0
                  ? candidate.quiz.id
                  : `${candidate.quiz.id}-anchor-${index + 1}`,
                ownerId: input.evidence.ownerId,
                contentId: input.evidence.contentId,
                contentVersion: input.evidence.contentVersion,
                knowledgeAnchorIds: freeze([
                  input.evidence.anchors[index].id,
                ]),
                kind: candidate.quiz.kind,
                prompt: candidate.quiz.prompt,
                version: 1,
                generatedAt: input.generatedAt,
                eligibleAt: input.eligibleAt,
                generatorVersion: "fixture-generator-v2",
                policyVersion: input.policyVersion,
                provenance: /** @type {const} */ ("fixture-generator"),
              })),
          );
        },
      },
      createId: () => crypto.randomUUID(),
    });
  }

  /** @param {PromptGenerationEvent} event */
  restore(event) {
    return this.#repository.record(event);
  }

  /**
   * @param {readonly { readonly candidate: CatalogCandidate, readonly studiedAt: string }[]} studied
   * @returns {Promise<Result<{ readonly nextEligibleAt: string | null, readonly prompts: readonly import("./contracts.js").GeneratedPrompt[] }, import("./contracts.js").PromptBankFailure>>}
   */
  async generateDue(studied) {
    /** @type {string[]} */
    const waitingUntil = [];
    for (const item of studied) {
      if (
        this.#repository.listEvents(this.#ownerId).some((event) =>
          event.contentId === item.candidate.id
        )
      ) continue;
      const evidence = evidenceFor(item.candidate, this.#ownerId);
      const generated = await this.#service.generate({
        ownerId: evidence.ownerId,
        contentId: item.candidate.id,
        contentVersion: 1,
        evidence,
        studyFact: {
          id: `study-fact:${item.candidate.id}`,
          ownerId: evidence.ownerId,
          contentId: item.candidate.id,
          contentVersion: 1,
          studiedAt: item.studiedAt,
        },
        idempotencyKey: `prompt-generation:${item.candidate.id}:v1`,
      });
      if (
        !generated.ok && generated.error.kind === "PromptGenerationTooEarly"
      ) {
        waitingUntil.push(generated.error.eligibleAt);
      } else if (!generated.ok) {
        return generated;
      }
    }
    return {
      ok: true,
      value: freeze({
        nextEligibleAt: waitingUntil.sort()[0] ?? null,
        prompts: this.#repository.listPrompts(this.#ownerId),
      }),
    };
  }

  /** @param {string} ownerId */
  listPrompts(ownerId) {
    return this.#repository.listPrompts(ownerId);
  }
}

/**
 * @param {CatalogCandidate} candidate
 * @param {string} ownerId
 */
function evidenceFor(candidate, ownerId) {
  const words = candidate.summary.trim().split(/\s+/).filter(Boolean);
  const sentences = candidate.summary.split(/[.!?]+/).filter((
    /** @type {string} */ value,
  ) => value.trim() !== "");
  return freeze({
    ownerId,
    contentId: candidate.id,
    contentVersion: 1,
    sourceKind: /** @type {const} */ ("text"),
    wordCount: Math.max(1, words.length),
    sentenceCount: Math.max(1, sentences.length),
    paragraphCount: 1,
    transcriptSource: null,
    anchors: freeze(candidate.knowledgeUnitIds.map((
      /** @type {string} */ id,
    ) => freeze({ id, excerpt: candidate.summary }))),
    evidenceVersion: "fixture-summary-v1",
    provenance: candidate.discovery.canonicalUrl,
  });
}
