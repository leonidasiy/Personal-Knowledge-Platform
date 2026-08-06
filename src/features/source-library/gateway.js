// @ts-check

import {
  isIsoDateTime,
  isNonEmptyText,
  isPublicHttpsUrl,
  isRecord,
} from "./contracts.js";

/** @import { LibrarySource, Result, SourceCatalogPage, SourceInterestArea, SourceSearchHit, SourceSuppression } from "./contracts.js" */

/** @typedef {{ readonly kind: "SourceGatewayCommandInvalid", readonly field: string } | { readonly kind: "SourceGatewayUnauthenticated" } | { readonly kind: "SourceGatewayUnauthorized" } | { readonly kind: "SourceGatewayUnavailable" } | { readonly kind: "SourceGatewayTimedOut" } | { readonly kind: "SourceGatewayResponseInvalid" } | { readonly kind: "SourceGatewayRejected", readonly failureKind: string }} SourceGatewayFailure */

const freeze = Object.freeze;

export class SourceLibraryGatewayClient {
  /** @type {typeof fetch} */ #fetch;
  /** @type {URL} */ #base;
  /** @type {number} */ #timeoutMs;

  /** @param {{ readonly fetch: typeof fetch, readonly baseUrl: string, readonly timeoutMs: number }} dependencies */
  constructor(dependencies) {
    if (
      typeof dependencies.fetch !== "function" ||
      !URL.canParse(dependencies.baseUrl) ||
      !Number.isInteger(dependencies.timeoutMs) || dependencies.timeoutMs < 1
    ) {
      throw new TypeError("SourceGatewayDependencyInvalid");
    }
    this.#base = new URL(dependencies.baseUrl);
    if (
      this.#base.protocol !== "https:" && this.#base.hostname !== "localhost" &&
      this.#base.hostname !== "127.0.0.1"
    ) {
      throw new TypeError("SourceGatewayProtocolInvalid");
    }
    this.#fetch = dependencies.fetch;
    this.#timeoutMs = dependencies.timeoutMs;
  }

  /** @param {unknown} command @returns {Promise<Result<SourceCatalogPage, SourceGatewayFailure>>} */
  async browse(command) {
    if (
      !isRecord(command) || typeof command.limit !== "number" ||
      !Number.isInteger(command.limit) || command.limit < 1 ||
      (command.cursor !== null && command.cursor !== undefined &&
        !isNonEmptyText(command.cursor))
    ) {
      return invalid("command");
    }
    const params = new URLSearchParams({ limit: String(command.limit) });
    if (isNonEmptyText(command.cursor)) params.set("cursor", command.cursor);
    const response = await this.#request(
      `api/source-library?${params}`,
      "GET",
      null,
    );
    if (!response.ok) return response;
    const result = isRecord(response.value) ? response.value.result : null;
    return sourcePage(result);
  }

  /** @param {unknown} command @returns {Promise<Result<readonly SourceSearchHit[], SourceGatewayFailure>>} */
  async search(command) {
    if (
      !isRecord(command) || !isNonEmptyText(command.query) ||
      (command.mode !== undefined && command.mode !== "keyword" &&
        command.mode !== "semantic" && command.mode !== "combined") ||
      typeof command.limit !== "number" || !Number.isInteger(command.limit) ||
      command.limit < 1
    ) {
      return invalid("command");
    }
    const params = new URLSearchParams({
      q: command.query.trim(),
      mode: command.mode ?? "combined",
      limit: String(command.limit),
    });
    const response = await this.#request(
      `api/source-library/search?${params}`,
      "GET",
      null,
    );
    if (!response.ok) return response;
    const values = isRecord(response.value) ? response.value.result : null;
    if (!Array.isArray(values)) return bad();
    /** @type {SourceSearchHit[]} */ const hits = [];
    for (const value of values) {
      if (
        !isRecord(value) || typeof value.score !== "number" ||
        !Number.isFinite(value.score)
      ) return bad();
      const source = parseSource(value.source);
      if (source === null || source.state !== "active") return bad();
      hits.push(freeze({ source, score: value.score }));
    }
    return { ok: true, value: freeze(hits) };
  }

  /** @param {unknown} command @returns {Promise<Result<LibrarySource, SourceGatewayFailure>>} */
  async disable(command) {
    if (
      !isRecord(command) || !isNonEmptyText(command.sourceId) ||
      !isNonEmptyText(command.idempotencyKey) ||
      typeof command.expectedRevision !== "number" ||
      !Number.isInteger(command.expectedRevision) ||
      command.expectedRevision < 1
    ) return invalid("command");
    const response = await this.#request(
      "api/source-library/disable",
      "POST",
      command,
    );
    if (!response.ok) return response;
    const value = isRecord(response.value) ? response.value.result : null;
    const source = parseSource(value);
    return source === null ? bad() : { ok: true, value: source };
  }

  /** @param {unknown} command @returns {Promise<Result<{ readonly source: LibrarySource, readonly reused: boolean }, SourceGatewayFailure>>} */
  async approve(command) {
    if (!isRecord(command) || Object.hasOwn(command, "ownerId")) {
      return invalid("command");
    }
    const response = await this.#request(
      "api/source-library/approve",
      "POST",
      command,
    );
    if (!response.ok) return response;
    const value = isRecord(response.value) ? response.value.result : null;
    if (!isRecord(value) || typeof value.reused !== "boolean") return bad();
    const source = parseSource(value.source);
    if (source === null) return bad();
    return { ok: true, value: freeze({ source, reused: value.reused }) };
  }

  /** @param {unknown} command @returns {Promise<Result<{ readonly status: "processing-ready", readonly reused: boolean }, SourceGatewayFailure>>} */
  async uploadManualMaterial(command) {
    if (!isRecord(command) || Object.hasOwn(command, "ownerId")) {
      return invalid("command");
    }
    const response = await this.#request(
      "api/source-library/manual-material",
      "POST",
      command,
    );
    if (!response.ok) return response;
    const value = isRecord(response.value) ? response.value.result : null;
    if (
      !isRecord(value) || value.status !== "processing-ready" ||
      typeof value.reused !== "boolean"
    ) return bad();
    return {
      ok: true,
      value: freeze({ status: "processing-ready", reused: value.reused }),
    };
  }

  /** @param {unknown} command @returns {Promise<Result<{ readonly suppression: SourceSuppression, readonly reused: boolean }, SourceGatewayFailure>>} */
  async reject(command) {
    if (!isRecord(command) || Object.hasOwn(command, "ownerId")) {
      return invalid("command");
    }
    const response = await this.#request(
      "api/source-library/reject",
      "POST",
      command,
    );
    if (!response.ok) return response;
    const value = isRecord(response.value) ? response.value.result : null;
    if (!isRecord(value) || typeof value.reused !== "boolean") return bad();
    const suppression = parseSuppression(value.suppression);
    if (suppression === null) return bad();
    return { ok: true, value: freeze({ suppression, reused: value.reused }) };
  }

  /** @param {readonly string[]} canonicalIdentities @returns {Promise<Result<readonly string[], SourceGatewayFailure>>} */
  async suppressed(canonicalIdentities) {
    if (
      !Array.isArray(canonicalIdentities) || canonicalIdentities.length < 1 ||
      canonicalIdentities.length > 50 ||
      canonicalIdentities.some((value) => !isNonEmptyText(value))
    ) return invalid("canonicalIdentities");
    const response = await this.#request(
      "api/source-library/suppressions/check",
      "POST",
      { canonicalIdentities },
    );
    if (!response.ok) return response;
    const values = isRecord(response.value) ? response.value.result : null;
    if (
      !Array.isArray(values) || values.some((value) => !isNonEmptyText(value))
    ) return bad();
    return { ok: true, value: freeze(/** @type {string[]} */ ([...values])) };
  }

  /** @param {readonly string[]} sourceIds @returns {Promise<Result<readonly string[], SourceGatewayFailure>>} */
  async active(sourceIds) {
    if (
      !Array.isArray(sourceIds) || sourceIds.length < 1 ||
      sourceIds.length > 50 ||
      sourceIds.some((value) => !isNonEmptyText(value))
    ) return invalid("sourceIds");
    const requested = new Set(sourceIds);
    const response = await this.#request(
      "api/source-library/active/check",
      "POST",
      { sourceIds },
    );
    if (!response.ok) return response;
    const values = isRecord(response.value) ? response.value.result : null;
    if (
      !Array.isArray(values) ||
      values.some((value) => !isNonEmptyText(value) || !requested.has(value))
    ) return bad();
    return {
      ok: true,
      value: freeze(/** @type {string[]} */ ([...new Set(values)])),
    };
  }

  /** @param {string} path @param {"GET" | "POST"} method @param {unknown} body @returns {Promise<Result<unknown, SourceGatewayFailure>>} */
  async #request(path, method, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    /** @type {Response} */ let response;
    try {
      response = await (0, this.#fetch)(new URL(path, this.#base), {
        method,
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          ...(body === null ? {} : { "content-type": "application/json" }),
        },
        body: body === null ? null : JSON.stringify(body),
        cache: "no-store",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return { ok: false, error: { kind: "SourceGatewayTimedOut" } };
      }
      if (error instanceof TypeError) {
        return { ok: false, error: { kind: "SourceGatewayUnavailable" } };
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 401) {
      return { ok: false, error: { kind: "SourceGatewayUnauthenticated" } };
    }
    if (response.status === 403) {
      return { ok: false, error: { kind: "SourceGatewayUnauthorized" } };
    }
    /** @type {unknown} */ let document;
    try {
      document = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) return bad();
      throw error;
    }
    if (!response.ok) {
      const failureKind = isRecord(document) && isNonEmptyText(document.error)
        ? document.error
        : null;
      return failureKind === null
        ? bad()
        : { ok: false, error: { kind: "SourceGatewayRejected", failureKind } };
    }
    return { ok: true, value: document };
  }
}

/** @param {unknown} value @returns {Result<SourceCatalogPage, SourceGatewayFailure>} */
function sourcePage(value) {
  if (
    !isRecord(value) || !Array.isArray(value.items) ||
    !Array.isArray(value.interestAreas) ||
    (value.nextCursor !== null && typeof value.nextCursor !== "string")
  ) return bad();
  /** @type {LibrarySource[]} */ const items = [];
  for (const candidate of value.items) {
    const source = parseSource(candidate);
    if (source === null || source.state !== "active") return bad();
    items.push(source);
  }
  /** @type {SourceInterestArea[]} */ const interestAreas = [];
  for (const candidate of value.interestAreas) {
    if (
      !isRecord(candidate) || !isNonEmptyText(candidate.id) ||
      !isNonEmptyText(candidate.ownerId) || !isNonEmptyText(candidate.title) ||
      !isNonEmptyText(candidate.provenance)
    ) return bad();
    interestAreas.push(
      freeze({
        id: candidate.id,
        ownerId: candidate.ownerId,
        title: candidate.title,
        provenance: candidate.provenance,
      }),
    );
  }
  return {
    ok: true,
    value: freeze({
      items: freeze(items),
      interestAreas: freeze(interestAreas),
      nextCursor: value.nextCursor,
    }),
  };
}

/** @param {unknown} value @returns {LibrarySource | null} */
function parseSource(value) {
  if (
    !isRecord(value) || !isNonEmptyText(value.id) ||
    !isNonEmptyText(value.ownerId) || !isPublicHttpsUrl(value.submittedUrl) ||
    !isPublicHttpsUrl(value.canonicalUrl) || !isNonEmptyText(value.title) ||
    !isNonEmptyText(value.description) || !isRecord(value.adapter) ||
    !isNonEmptyText(value.adapter.id) ||
    !isNonEmptyText(value.adapter.version) ||
    !isNonEmptyText(value.adapter.granularity) ||
    !Array.isArray(value.adapter.capabilities) ||
    value.adapter.capabilities.some((item) => !isNonEmptyText(item)) ||
    !Array.isArray(value.interestAreaIds) ||
    value.interestAreaIds.some((item) => !isNonEmptyText(item)) ||
    !Array.isArray(value.identityEvidence) ||
    (value.state !== "active" && value.state !== "disabled") ||
    !isIsoDateTime(value.approvedAt) || !isIsoDateTime(value.updatedAt) ||
    typeof value.revision !== "number" || !Number.isInteger(value.revision) ||
    value.revision < 1
  ) return null;
  return freeze(
    /** @type {LibrarySource} */ ({
      ...value,
      adapter: freeze({
        ...value.adapter,
        capabilities: freeze([...value.adapter.capabilities]),
      }),
      interestAreaIds: freeze([...value.interestAreaIds]),
      identityEvidence: freeze([...value.identityEvidence]),
    }),
  );
}

/** @param {unknown} value @returns {SourceSuppression | null} */
function parseSuppression(value) {
  if (
    !isRecord(value) || !isNonEmptyText(value.id) ||
    !isNonEmptyText(value.ownerId) ||
    !isNonEmptyText(value.canonicalIdentity) ||
    !Array.isArray(value.identityEvidence) ||
    !isNonEmptyText(value.idempotencyKey) || !isIsoDateTime(value.createdAt)
  ) return null;
  return freeze(
    /** @type {SourceSuppression} */ ({
      ...value,
      identityEvidence: freeze([...value.identityEvidence]),
    }),
  );
}

/** @returns {Result<never, SourceGatewayFailure>} */
function bad() {
  return { ok: false, error: { kind: "SourceGatewayResponseInvalid" } };
}
/** @param {string} field @returns {Result<never, SourceGatewayFailure>} */
function invalid(field) {
  return { ok: false, error: { kind: "SourceGatewayCommandInvalid", field } };
}

export {};
