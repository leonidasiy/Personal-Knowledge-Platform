// @ts-check

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */
/** @typedef {{ readonly kind: "LearningGenerationEnqueueCommandInvalid", readonly field: string } | { readonly kind: "LearningGenerationEnqueueLimitExceeded", readonly maximum: number, readonly actual: number } | { readonly kind: "LearningGenerationEnqueueFailed" }} EnqueueFailure */

const freeze = Object.freeze;

export class LearningGenerationEnqueuer {
  #generate;
  #now;
  #logger;
  #maximumItems;

  /** @param {{ readonly generate: (command: unknown) => Promise<Result<unknown, { readonly kind: string }>>, readonly now: () => string, readonly logger: (entry: { readonly event: string, readonly failureKind?: string, readonly itemCount?: number }) => void, readonly maximumItems: number }} dependencies */
  constructor(dependencies) {
    if (typeof dependencies?.generate !== "function" || typeof dependencies.now !== "function" || typeof dependencies.logger !== "function" || !Number.isInteger(dependencies.maximumItems) || dependencies.maximumItems < 1) throw new TypeError("Learning-generation enqueuer dependencies are invalid.");
    this.#generate = dependencies.generate;
    this.#now = dependencies.now;
    this.#logger = dependencies.logger;
    this.#maximumItems = dependencies.maximumItems;
  }

  /** @param {unknown} input @returns {Promise<Result<{ readonly enqueued: number }, EnqueueFailure>>} */
  async enqueue(input) {
    const now = this.#now();
    if (!isIsoDateTime(now)) throw new TypeError("Learning-generation enqueuer clock returned an invalid time.");
    const command = validate(input, this.#maximumItems);
    if (!command.ok) return this.#fail(command.error);
    this.#logger({ event: "learning-generation-enqueue-entry", itemCount: command.value.items.length });
    let failures = 0;
    for (const item of command.value.items) {
      const generated = await this.#generate({
        ownerId: command.value.ownerId,
        sourceId: command.value.sourceId,
        sourceRevision: command.value.sourceRevision,
        itemId: item.itemId,
        itemVersionId: item.itemVersionId,
        contentDigest: item.contentDigest,
        sourceKind: "public-text",
        content: item.content,
        rights: { kind: "public", ownerId: command.value.ownerId, sourceId: command.value.sourceId, sourceRevision: command.value.sourceRevision, evidenceId: command.value.rightsEvidenceId, status: "active", storageAllowed: true, displayAllowed: true, transformationAllowed: true, assessedAt: now, expiresAt: null, attribution: command.value.attribution },
        idempotencyKey: `learning-generation:${command.value.sourceId}:${item.itemId}:${item.itemVersionId}:${item.contentDigest}:${command.value.policy.version}`,
        policy: command.value.policy,
      });
      if (!generated.ok) {
        failures += 1;
        this.#logger({ event: "learning-generation-enqueue-item-failure", failureKind: generated.error.kind });
      }
    }
    if (failures > 0) return this.#fail({ kind: "LearningGenerationEnqueueFailed" });
    this.#logger({ event: "learning-generation-enqueue-success", itemCount: command.value.items.length });
    return { ok: true, value: freeze({ enqueued: command.value.items.length }) };
  }

  /** @param {EnqueueFailure} failure @returns {Result<never, EnqueueFailure>} */
  #fail(failure) { this.#logger({ event: "learning-generation-enqueue-failure", failureKind: failure.kind }); return { ok: false, error: failure }; }
}

/** @param {unknown} value @param {number} maximumItems @returns {Result<{ readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly rightsEvidenceId: string, readonly attribution: { readonly label: string, readonly sourceUrl: string }, readonly policy: { readonly version: string }, readonly items: readonly { readonly itemId: string, readonly itemVersionId: string, readonly contentDigest: string, readonly content: string }[] }, EnqueueFailure>} */
function validate(value, maximumItems) {
  if (!isRecord(value)) return invalid("command");
  for (const field of ["ownerId", "sourceId", "rightsEvidenceId"]) if (!isNonEmptyText(value[field])) return invalid(field);
  if (!isPositiveInteger(value.sourceRevision)) return invalid("sourceRevision");
  if (!isRecord(value.attribution) || !isNonEmptyText(value.attribution.label) || !isPublicHttps(value.attribution.sourceUrl)) return invalid("attribution");
  if (!isRecord(value.policy) || !isNonEmptyText(value.policy.version)) return invalid("policy");
  if (!Array.isArray(value.items)) return invalid("items");
  if (value.items.length > maximumItems) return { ok: false, error: { kind: "LearningGenerationEnqueueLimitExceeded", maximum: maximumItems, actual: value.items.length } };
  const items = [];
  for (const item of value.items) {
    if (!isRecord(item) || !isNonEmptyText(item.itemId) || !isNonEmptyText(item.itemVersionId) || !isNonEmptyText(item.contentDigest) || typeof item.content !== "string" || item.content.trim() === "") return invalid("items");
    items.push(freeze({ itemId: item.itemId.trim(), itemVersionId: item.itemVersionId.trim(), contentDigest: item.contentDigest.trim(), content: item.content }));
  }
  const checked = /** @type {{ readonly ownerId: string, readonly sourceId: string, readonly sourceRevision: number, readonly rightsEvidenceId: string, readonly attribution: { readonly label: string, readonly sourceUrl: string }, readonly policy: { readonly version: string } }} */ (value);
  return { ok: true, value: freeze({ ownerId: checked.ownerId.trim(), sourceId: checked.sourceId.trim(), sourceRevision: checked.sourceRevision, rightsEvidenceId: checked.rightsEvidenceId.trim(), attribution: freeze({ label: checked.attribution.label.trim(), sourceUrl: new URL(checked.attribution.sourceUrl).href }), policy: checked.policy, items: freeze(items) }) };
}
/** @param {string} field @returns {Result<never, EnqueueFailure>} */
function invalid(field) { return { ok: false, error: { kind: "LearningGenerationEnqueueCommandInvalid", field } }; }
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function isNonEmptyText(value) { return typeof value === "string" && value.trim() !== ""; }
/** @param {unknown} value @returns {value is number} */
function isPositiveInteger(value) { return typeof value === "number" && Number.isInteger(value) && value > 0; }
/** @param {unknown} value @returns {value is string} */
function isPublicHttps(value) { if (!isNonEmptyText(value) || !URL.canParse(value)) return false; const url = new URL(value); return url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === ""; }
/** @param {unknown} value @returns {value is string} */
function isIsoDateTime(value) { return isNonEmptyText(value) && Number.isFinite(Date.parse(value)); }

export {};
