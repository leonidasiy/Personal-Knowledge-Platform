// @ts-check

/** @template T, E @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result */
/** @typedef {{ readonly kind: "WikimediaCommandInvalid", readonly field: string } | { readonly kind: "WikimediaTargetNotFound" } | { readonly kind: "WikimediaOwnerMismatch" } | { readonly kind: "WikimediaItemIdentityMissing" } | { readonly kind: "WikimediaItemIdentityAmbiguous" } | { readonly kind: "WikimediaFileRevisionConflict" } | { readonly kind: "WikimediaLicenseMissing" } | { readonly kind: "WikimediaLicenseAmbiguous" } | { readonly kind: "WikimediaLicenseConflict" } | { readonly kind: "WikimediaLicenseUnsupported" } | { readonly kind: "WikimediaLicenseExpired" } | { readonly kind: "WikimediaAttributionMissing" } | { readonly kind: "WikimediaTimedTextMissing" } | { readonly kind: "WikimediaTimedTextAmbiguous" } | { readonly kind: "WikimediaTimedTextConflict" } | { readonly kind: "WikimediaTimedTextUnsupported" } | { readonly kind: "WikimediaTimedTextExpired" } | { readonly kind: "WikimediaTimedTextFetchFailed" } | { readonly kind: "WikimediaTimedTextTooLarge", readonly maximum: number } | { readonly kind: "WikimediaMediaAcquisitionDisallowed" }} WikimediaFailure */
/** @typedef {{ readonly ownerId:string, readonly sourceId:string, readonly sourceRevision:number, readonly itemId:string, readonly itemVersionId:string, readonly providerIdentity:string }} StoredWikimediaTarget */
/** @typedef {{ readonly identifiers:readonly string[], readonly references:readonly string[], readonly expiresAt:string|null }} LicenseEvidence */
/** @typedef {{ readonly fileRevisionId:string, readonly timedTextRevisionId:string, readonly timedTextUrl:string, readonly attribution:string, readonly fileLicense:LicenseEvidence, readonly timedTextLicense:LicenseEvidence }} ResolvedWikimediaEvidence */

const freeze = Object.freeze;

export class WikimediaTimedTextAdapter {
  #dependencies;
  /**
   * @param {{
   *   readonly targets:{ readonly find:(command:{readonly ownerId:string,readonly sourceId:string,readonly sourceRevision:number,readonly itemId:string,readonly itemVersionId:string})=>Promise<Result<StoredWikimediaTarget,WikimediaFailure>> },
   *   readonly evidence:{ readonly resolve:(target:StoredWikimediaTarget,language:string)=>Promise<Result<ResolvedWikimediaEvidence,WikimediaFailure>> },
   *   readonly fetch: typeof fetch,
   *   readonly validateDestination: (url: string) => Result<URL, { readonly kind: string }>,
   *   readonly assessLicense: (evidence: { readonly identifiers: readonly string[], readonly references: readonly string[] }) => Result<{ readonly supported: true }, { readonly kind: "missing" | "ambiguous" | "conflict" | "unsupported" }>,
   *   readonly digest: (bytes: Uint8Array) => Promise<Result<string, { readonly kind: string }>>,
   *   readonly now: () => string,
   *   readonly maximumBytes: number,
   *   readonly supportedMediaTypes: ReadonlySet<string>
   * }} dependencies
   */
  constructor(dependencies) {
    if (typeof dependencies?.targets?.find !== "function" || typeof dependencies.evidence?.resolve !== "function" ||
      typeof dependencies.fetch !== "function" || typeof dependencies.validateDestination !== "function" ||
      typeof dependencies.assessLicense !== "function" || typeof dependencies.digest !== "function" ||
      typeof dependencies.now !== "function" || !Number.isInteger(dependencies.maximumBytes) || dependencies.maximumBytes < 1 ||
      !(dependencies.supportedMediaTypes instanceof Set)) throw new TypeError("Wikimedia TimedText dependencies are invalid.");
    this.#dependencies = dependencies;
  }

  /** @param {unknown} input @returns {Promise<Result<{ readonly fileRevisionId: string, readonly timedTextRevisionId: string, readonly timedTextUrl: string, readonly language: string, readonly text: string, readonly digest: string, readonly attribution: string, readonly acquiredAt: string }, WikimediaFailure>>} */
  async retrieve(input) {
    const command = validateCommand(input);
    if (!command.ok) return command;
    const target = await this.#dependencies.targets.find(command.value);
    if (!target.ok) return target;
    if (target.value.ownerId !== command.value.ownerId || target.value.sourceId !== command.value.sourceId ||
      target.value.sourceRevision !== command.value.sourceRevision || target.value.itemId !== command.value.itemId ||
      target.value.itemVersionId !== command.value.itemVersionId) throw new TypeError("Wikimedia target loader broke its identity contract.");
    const resolved = await this.#dependencies.evidence.resolve(target.value, command.value.language);
    if (!resolved.ok) return resolved;
    if (!validResolvedEvidence(resolved.value)) return { ok: false, error: { kind: "WikimediaTimedTextConflict" } };
    const fileLicense = this.#license(resolved.value.fileLicense, "file");
    if (!fileLicense.ok) return fileLicense;
    const textLicense = this.#license(resolved.value.timedTextLicense, "timedtext");
    if (!textLicense.ok) return textLicense;
    const destination = this.#dependencies.validateDestination(resolved.value.timedTextUrl);
    if (!destination.ok) return { ok: false, error: { kind: "WikimediaTimedTextFetchFailed" } };
    let response;
    try {
      response = await this.#dependencies.fetch(destination.value, { method: "GET", redirect: "manual", headers: { accept: "text/vtt, text/plain" } });
    } catch (error) {
      if (error instanceof Error) return { ok: false, error: { kind: "WikimediaTimedTextFetchFailed" } };
      throw error;
    }
    if (!response.ok || (response.status >= 300 && response.status < 400)) return { ok: false, error: { kind: "WikimediaTimedTextFetchFailed" } };
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
    if (!this.#dependencies.supportedMediaTypes.has(mediaType)) return { ok: false, error: { kind: "WikimediaTimedTextUnsupported" } };
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.#dependencies.maximumBytes) return { ok: false, error: { kind: "WikimediaTimedTextTooLarge", maximum: this.#dependencies.maximumBytes } };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.#dependencies.maximumBytes) return { ok: false, error: { kind: "WikimediaTimedTextTooLarge", maximum: this.#dependencies.maximumBytes } };
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim(); }
    catch (error) { if (error instanceof TypeError) return { ok: false, error: { kind: "WikimediaTimedTextUnsupported" } }; throw error; }
    if (text === "") return { ok: false, error: { kind: "WikimediaTimedTextMissing" } };
    const digest = await this.#dependencies.digest(bytes);
    if (!digest.ok) return { ok: false, error: { kind: "WikimediaTimedTextFetchFailed" } };
    return { ok: true, value: freeze({ fileRevisionId: resolved.value.fileRevisionId, timedTextRevisionId: resolved.value.timedTextRevisionId, timedTextUrl: destination.value.href, language: command.value.language, text, digest: digest.value, attribution: resolved.value.attribution, acquiredAt: this.#dependencies.now() }) };
  }

  /** @param {LicenseEvidence} evidence @param {"file" | "timedtext"} target @returns {Result<{ readonly supported: true }, WikimediaFailure>} */
  #license(evidence, target) {
    if (evidence.expiresAt !== null && Date.parse(evidence.expiresAt) <= Date.parse(this.#dependencies.now())) {
      return { ok: false, error: { kind: target === "file" ? "WikimediaLicenseExpired" : "WikimediaTimedTextExpired" } };
    }
    const assessed = this.#dependencies.assessLicense({ identifiers: evidence.identifiers, references: evidence.references });
    if (assessed.ok) return assessed;
    const prefix = target === "file" ? "WikimediaLicense" : "WikimediaTimedText";
    const suffix = assessed.error.kind === "missing" ? "Missing" : assessed.error.kind === "ambiguous" ? "Ambiguous" : assessed.error.kind === "conflict" ? "Conflict" : "Unsupported";
    return { ok: false, error: /** @type {WikimediaFailure} */ ({ kind: prefix + suffix }) };
  }
}

/** @param {unknown} value @returns {Result<{readonly ownerId:string,readonly sourceId:string,readonly sourceRevision:number,readonly itemId:string,readonly itemVersionId:string,readonly language:string},WikimediaFailure>} */
function validateCommand(value) {
  if (!record(value)) return invalid("command");
  const fields = ["ownerId", "sourceId", "sourceRevision", "itemId", "itemVersionId", "language"];
  if (Object.keys(value).some((field) => !fields.includes(field))) return invalid("command");
  for (const field of ["ownerId", "sourceId", "itemId", "itemVersionId", "language"]) if (!text(value[field])) return invalid(field);
  if (!Number.isInteger(value.sourceRevision) || Number(value.sourceRevision) < 1) return invalid("sourceRevision");
  return { ok: true, value: freeze({ ownerId: /** @type {string} */ (value.ownerId).trim(), sourceId: /** @type {string} */ (value.sourceId).trim(), sourceRevision: /** @type {number} */ (value.sourceRevision), itemId: /** @type {string} */ (value.itemId).trim(), itemVersionId: /** @type {string} */ (value.itemVersionId).trim(), language: /** @type {string} */ (value.language).trim() }) };
}

/** @param {unknown} value @returns {value is ResolvedWikimediaEvidence} */
function validResolvedEvidence(value) {
  if (!record(value) || !text(value.fileRevisionId) || !text(value.timedTextRevisionId) || !text(value.timedTextUrl) || !text(value.attribution)) return false;
  return validLicense(value.fileLicense) && validLicense(value.timedTextLicense);
}
/** @param {unknown} value @returns {value is LicenseEvidence} */
function validLicense(value) {
  return record(value) && Array.isArray(value.identifiers) && value.identifiers.every(text) &&
    Array.isArray(value.references) && value.references.every(text) && (value.expiresAt === null || text(value.expiresAt));
}
/** @param {string} field @returns {Result<never,WikimediaFailure>} */
function invalid(field) { return { ok: false, error: { kind: "WikimediaCommandInvalid", field } }; }
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function text(value) { return typeof value === "string" && value.trim() !== ""; }
export {};
