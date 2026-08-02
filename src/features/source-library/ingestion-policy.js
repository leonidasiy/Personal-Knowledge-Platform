// @ts-check

import {
  isIsoDateTime,
  isNonEmptyText,
  isPositiveInteger,
  isPublicHttpsUrl,
  isRecord,
} from "./ingestion-contracts.js";

/** @import { CapabilityEvidence, Result, SourceCrawlPlan, SourceIngestionFailure, SourceIngestionPolicy, SourcePolicyAssessmentCommand, StructuralDepthEvidence } from "./ingestion-contracts.js" */

const freeze = Object.freeze;

export class SourcePolicyEvaluator {
  /** @type {SourceIngestionPolicy} */
  #policy;
  /** @type {() => string} */
  #now;

  /**
   * @param {{ readonly policy: SourceIngestionPolicy, readonly now: () => string }} dependencies
   */
  constructor(dependencies) {
    if (!validPolicy(dependencies?.policy) || typeof dependencies.now !== "function") {
      throw new TypeError("Source policy dependencies are invalid.");
    }
    this.#policy = freeze({ ...dependencies.policy });
    this.#now = dependencies.now;
  }

  /** @param {unknown} command @returns {Result<SourceCrawlPlan, SourceIngestionFailure>} */
  assess(command) {
    const parsed = validateAssessmentCommand(command);
    if (!parsed.ok) return parsed;
    const assessedAt = this.#now();
    if (!isIsoDateTime(assessedAt)) {
      throw new TypeError("Source policy clock returned an invalid time.");
    }
    const access = accessFailure(parsed.value);
    if (access !== null) return { ok: false, error: access };
    const rights = rightsFailure(parsed.value.rights, assessedAt);
    if (rights !== null) return { ok: false, error: rights };

    const selected = selectDepth(
      parsed.value.rootUrl,
      parsed.value.structuralEvidence,
      this.#policy,
    );
    if (!selected.ok) return selected;
    return {
      ok: true,
      value: freeze({
        policyVersion: this.#policy.version,
        ownerId: parsed.value.ownerId,
        sourceId: parsed.value.sourceId,
        sourceRevision: parsed.value.sourceRevision,
        rootUrl: parsed.value.rootUrl,
        selectedDepth: selected.value.depth,
        depthReason: selected.value.reason,
        depthEvidence: selected.value.evidence,
        maximumPages: this.#policy.maximumPages,
        maximumDecodedBytes: this.#policy.maximumDecodedBytes,
        maximumConcurrency: this.#policy.maximumConcurrency,
        maximumDurationMs: this.#policy.maximumDurationMs,
        maximumRedirects: this.#policy.maximumRedirects,
        refreshIntervalMs: this.#policy.refreshIntervalMs,
        assessedAt,
      }),
    };
  }

  /**
   * Convert an observed runner boundary into a resumable, named stop.
   * @param {unknown} observation
   * @returns {Result<{ readonly state: "within-policy" }, SourceIngestionFailure>}
   */
  checkBoundary(observation) {
    if (!isRecord(observation)) return invalid("observation");
    const fields = /** @type {const} */ ([
      "pages",
      "depth",
      "decodedBytes",
      "concurrency",
      "durationMs",
      "redirects",
    ]);
    for (const field of fields) {
      if (
        typeof observation[field] !== "number" ||
        !Number.isInteger(observation[field]) || observation[field] < 0
      ) return invalid(field);
    }
    const checked = /** @type {{ readonly pages: number, readonly depth: number, readonly decodedBytes: number, readonly concurrency: number, readonly durationMs: number, readonly redirects: number }} */ (observation);
    if (checked.pages > this.#policy.maximumPages) {
      return fail({ kind: "CrawlPageLimitExceeded", maximum: this.#policy.maximumPages });
    }
    if (checked.depth > this.#policy.maximumDepth) {
      return fail({ kind: "CrawlDepthLimitExceeded", maximum: this.#policy.maximumDepth });
    }
    if (checked.decodedBytes > this.#policy.maximumDecodedBytes) {
      return fail({ kind: "CrawlByteLimitExceeded", maximum: this.#policy.maximumDecodedBytes });
    }
    if (checked.concurrency > this.#policy.maximumConcurrency) {
      return fail({ kind: "CrawlConcurrencyLimitExceeded", maximum: this.#policy.maximumConcurrency });
    }
    if (checked.durationMs > this.#policy.maximumDurationMs) {
      return fail({ kind: "CrawlDurationLimitExceeded", maximumMs: this.#policy.maximumDurationMs });
    }
    if (checked.redirects > this.#policy.maximumRedirects) {
      return fail({ kind: "CrawlRedirectLimitExceeded", maximum: this.#policy.maximumRedirects });
    }
    return { ok: true, value: freeze({ state: /** @type {const} */ ("within-policy") }) };
  }
}

/** @param {unknown} value @returns {value is SourceIngestionPolicy} */
function validPolicy(value) {
  return isRecord(value) && isNonEmptyText(value.version) &&
    isPositiveInteger(value.initialDepth) &&
    isPositiveInteger(value.maximumDepth) &&
    value.initialDepth <= value.maximumDepth &&
    isPositiveInteger(value.maximumPages) &&
    isPositiveInteger(value.maximumDecodedBytes) &&
    isPositiveInteger(value.maximumConcurrency) &&
    isPositiveInteger(value.maximumDurationMs) &&
    typeof value.maximumRedirects === "number" &&
    Number.isInteger(value.maximumRedirects) && value.maximumRedirects >= 0 &&
    isPositiveInteger(value.refreshIntervalMs);
}

/** @param {unknown} value @returns {Result<SourcePolicyAssessmentCommand, SourceIngestionFailure>} */
function validateAssessmentCommand(value) {
  if (!isRecord(value)) return invalid("command");
  if (!isNonEmptyText(value.ownerId)) return invalid("ownerId");
  if (!isNonEmptyText(value.sourceId)) return invalid("sourceId");
  if (!isPositiveInteger(value.sourceRevision)) return invalid("sourceRevision");
  if (!isPublicHttpsUrl(value.rootUrl)) return invalid("rootUrl");
  if (!["allowed", "denied", "unavailable", "malformed"].includes(String(value.robots))) return invalid("robots");
  if (!isNonEmptyText(value.robotsEvidenceReference)) return invalid("robotsEvidenceReference");
  if (!["allowed", "denied", "unknown"].includes(String(value.terms))) return invalid("terms");
  if (!isNonEmptyText(value.termsEvidenceReference)) return invalid("termsEvidenceReference");
  if (!["public", "denied", "authentication-required", "paywall"].includes(String(value.access))) return invalid("access");
  if (!isNonEmptyText(value.accessEvidenceReference)) return invalid("accessEvidenceReference");
  if (!isRecord(value.rights)) return invalid("rights");
  for (const capability of ["storage", "display", "transformation"]) {
    if (!validCapabilityEvidence(value.rights[capability])) return invalid(`rights.${capability}`);
  }
  const rights = /** @type {{ readonly storage: CapabilityEvidence, readonly display: CapabilityEvidence, readonly transformation: CapabilityEvidence }} */ (value.rights);
  if (!Array.isArray(value.structuralEvidence)) return invalid("structuralEvidence");
  const structuralEvidence = [];
  for (const entry of value.structuralEvidence) {
    if (!isRecord(entry) || (entry.kind !== "sitemap" && entry.kind !== "navigation") ||
      !isPublicHttpsUrl(entry.evidenceUrl) || !isPositiveInteger(entry.requiredDepth) ||
      !isIsoDateTime(entry.observedAt)) return invalid("structuralEvidence");
    structuralEvidence.push(freeze({
      kind: entry.kind,
      evidenceUrl: entry.evidenceUrl,
      requiredDepth: entry.requiredDepth,
      observedAt: entry.observedAt,
    }));
  }
  return { ok: true, value: /** @type {SourcePolicyAssessmentCommand} */ (freeze({
    ownerId: value.ownerId.trim(), sourceId: value.sourceId.trim(), sourceRevision: value.sourceRevision,
    rootUrl: new URL(value.rootUrl).href, robots: value.robots,
    robotsEvidenceReference: value.robotsEvidenceReference.trim(), terms: value.terms,
    termsEvidenceReference: value.termsEvidenceReference.trim(), access: value.access,
    accessEvidenceReference: value.accessEvidenceReference.trim(),
    rights: freeze({ storage: freeze({ ...rights.storage }), display: freeze({ ...rights.display }), transformation: freeze({ ...rights.transformation }) }),
    structuralEvidence: freeze(structuralEvidence),
  })) };
}

/** @param {unknown} value @returns {value is CapabilityEvidence} */
function validCapabilityEvidence(value) {
  return isRecord(value) && ["allowed", "denied", "unknown"].includes(String(value.outcome)) &&
    isNonEmptyText(value.evidenceReference) && isIsoDateTime(value.observedAt) &&
    (value.expiresAt === null || isIsoDateTime(value.expiresAt));
}

/** @param {SourcePolicyAssessmentCommand} value @returns {SourceIngestionFailure | null} */
function accessFailure(value) {
  if (value.robots === "unavailable") return { kind: "RobotsFetchUnavailable" };
  if (value.robots === "malformed") return { kind: "RobotsMalformed" };
  if (value.robots === "denied") return { kind: "RobotsDenied" };
  if (value.terms === "unknown") return { kind: "TermsUnknown" };
  if (value.terms === "denied") return { kind: "TermsDenied" };
  if (value.access === "denied") return { kind: "PublicAccessDenied" };
  if (value.access === "authentication-required") return { kind: "AuthenticationRequired" };
  if (value.access === "paywall") return { kind: "PaywallDetected" };
  return null;
}

/** @param {SourcePolicyAssessmentCommand["rights"]} rights @param {string} now @returns {SourceIngestionFailure | null} */
function rightsFailure(rights, now) {
  for (const capability of /** @type {const} */ (["storage", "display", "transformation"])) {
    const evidence = rights[capability];
    if (evidence.expiresAt !== null && Date.parse(evidence.expiresAt) <= Date.parse(now)) {
      return { kind: "RightsEvidenceExpired", capability };
    }
    if (evidence.outcome === "unknown") return { kind: "ContentRightsUnknown", capability };
    if (evidence.outcome === "denied") {
      return capability === "storage" ? { kind: "ContentStorageDenied" }
        : capability === "display" ? { kind: "ContentDisplayDenied" }
        : { kind: "ContentTransformationDenied" };
    }
  }
  return null;
}

/** @param {string} rootUrl @param {readonly StructuralDepthEvidence[]} evidence @param {SourceIngestionPolicy} policy @returns {Result<{ readonly depth: number, readonly reason: SourceCrawlPlan["depthReason"], readonly evidence: StructuralDepthEvidence | null }, SourceIngestionFailure>} */
function selectDepth(rootUrl, evidence, policy) {
  const boundary = new URL(rootUrl);
  const applicable = evidence.filter((entry) => withinBoundary(boundary, new URL(entry.evidenceUrl)));
  const chosen = applicable.reduce((current, entry) => current === null || entry.requiredDepth > current.requiredDepth ? entry : current, /** @type {StructuralDepthEvidence | null} */ (null));
  if (chosen === null || chosen.requiredDepth <= policy.initialDepth) {
    return { ok: true, value: freeze({ depth: policy.initialDepth, reason: /** @type {const} */ ("policy-default"), evidence: null }) };
  }
  if (chosen.requiredDepth > policy.maximumDepth) {
    return fail({ kind: "CrawlDepthLimitExceeded", maximum: policy.maximumDepth });
  }
  return { ok: true, value: freeze({ depth: chosen.requiredDepth, reason: chosen.kind === "sitemap" ? /** @type {const} */ ("sitemap-evidence") : /** @type {const} */ ("navigation-evidence"), evidence: chosen }) };
}

/** @param {URL} root @param {URL} candidate */
function withinBoundary(root, candidate) {
  if (root.origin !== candidate.origin) return false;
  const rootPath = root.pathname.endsWith("/") ? root.pathname : `${root.pathname}/`;
  return candidate.pathname === root.pathname || candidate.pathname.startsWith(rootPath);
}

/** @param {string} field @returns {Result<never, SourceIngestionFailure>} */
function invalid(field) {
  return { ok: false, error: { kind: "SourceIngestionCommandInvalid", field } };
}

/** @param {SourceIngestionFailure} error @returns {Result<never, SourceIngestionFailure>} */
function fail(error) {
  return { ok: false, error };
}

export {};
