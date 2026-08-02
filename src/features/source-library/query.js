// @ts-check

import { isNonEmptyText, isRecord } from "./contracts.js";

/** @import { LibrarySource, Result, SourceCatalogPage, SourceInterestArea, SourceLibraryFailure, SourceSearchHit, SourceSearchMode } from "./contracts.js" */

const freeze = Object.freeze;

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly approvedAt: string,
 *   readonly sourceId: string,
 *   readonly catalogRevision: string
 * }} SourceCursorValue
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly limit: number,
 *   readonly after: null | { readonly approvedAt: string, readonly sourceId: string }
 * }} SourcePageQuery
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly query: string,
 *   readonly limit: number
 * }} SourceKeywordQuery
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly sourceIds: readonly string[]
 * }} ActiveSourceQuery
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly vector: readonly number[],
 *   readonly modelId: string,
 *   readonly modelVersion: string,
 *   readonly dimensions: number,
 *   readonly limit: number
 * }} SemanticSourceQuery
 */

/**
 * @typedef {{
 *   readonly sourceId: string,
 *   readonly ownerId: string,
 *   readonly score: number,
 *   readonly modelId: string,
 *   readonly modelVersion: string,
 *   readonly dimensions: number
 * }} SemanticSourceHit
 */

/** @typedef {{ readonly ownerId: string, readonly limit: number, readonly cursor: string | null }} ValidatedBrowse */
/** @typedef {{ readonly ownerId: string, readonly query: string, readonly limit: number, readonly mode: SourceSearchMode }} ValidatedSearch */

/**
 * @typedef {{
 *   readonly repository: {
 *     readonly browseActive: (query: SourcePageQuery) => Promise<Result<{ readonly items: readonly LibrarySource[], readonly interestAreas: readonly SourceInterestArea[], readonly catalogRevision: string }, SourceLibraryFailure>>,
 *     readonly keywordSearch: (query: SourceKeywordQuery) => Promise<Result<readonly SourceSearchHit[], SourceLibraryFailure>>,
 *     readonly activeByIds: (query: ActiveSourceQuery) => Promise<Result<readonly LibrarySource[], SourceLibraryFailure>>
 *     readonly suppressed: (query: { readonly ownerId: string, readonly canonicalIdentities: readonly string[] }) => Promise<Result<readonly string[], SourceLibraryFailure>>
 *   },
 *   readonly cursorCodec: {
 *     readonly encode: (value: SourceCursorValue) => Promise<Result<string, SourceLibraryFailure>>,
 *     readonly decode: (value: string) => Promise<Result<SourceCursorValue, SourceLibraryFailure>>
 *   },
 *   readonly embedding: {
 *     readonly create: (text: string) => Promise<Result<{ readonly vector: readonly number[], readonly modelId: string, readonly modelVersion: string, readonly dimensions: number }, SourceLibraryFailure>>
 *   },
 *   readonly semanticIndex: {
 *     readonly search: (query: SemanticSourceQuery) => Promise<Result<readonly SemanticSourceHit[], SourceLibraryFailure>>
 *   },
 *   readonly maximumPageSize: number,
 *   readonly maximumQueryLength: number,
 *   readonly fusionVersion: string
 * }} SourceCatalogQueryDependencies
 */

export class SourceCatalogQueryService {
  /** @type {SourceCatalogQueryDependencies} */
  #dependencies;

  /** @param {SourceCatalogQueryDependencies} dependencies */
  constructor(dependencies) {
    if (
      typeof dependencies.repository?.browseActive !== "function" ||
      typeof dependencies.repository?.keywordSearch !== "function" ||
      typeof dependencies.repository?.activeByIds !== "function" ||
      typeof dependencies.repository?.suppressed !== "function" ||
      typeof dependencies.cursorCodec?.encode !== "function" ||
      typeof dependencies.cursorCodec?.decode !== "function" ||
      typeof dependencies.embedding?.create !== "function" ||
      typeof dependencies.semanticIndex?.search !== "function" ||
      !Number.isInteger(dependencies.maximumPageSize) ||
      dependencies.maximumPageSize < 1 ||
      !Number.isInteger(dependencies.maximumQueryLength) ||
      dependencies.maximumQueryLength < 1 ||
      !isNonEmptyText(dependencies.fusionVersion)
    ) {
      throw new TypeError("Source catalog query dependencies are invalid.");
    }
    this.#dependencies = dependencies;
  }

  /** @param {unknown} command @returns {Promise<Result<SourceCatalogPage, SourceLibraryFailure>>} */
  async browse(command) {
    const input = validateBrowse(command, this.#dependencies.maximumPageSize);
    if (!input.ok) return input;
    let after = null;
    /** @type {SourceCursorValue | null} */
    let cursorValue = null;
    if (input.value.cursor !== null) {
      const decoded = await this.#dependencies.cursorCodec.decode(
        input.value.cursor,
      );
      if (!decoded.ok) return decoded;
      if (decoded.value.ownerId !== input.value.ownerId) {
        return failure("SourceCursorOwnerMismatch");
      }
      after = freeze({
        approvedAt: decoded.value.approvedAt,
        sourceId: decoded.value.sourceId,
      });
      cursorValue = decoded.value;
    }
    const page = await this.#dependencies.repository.browseActive({
      ownerId: input.value.ownerId,
      limit: input.value.limit + 1,
      after,
    });
    if (!page.ok) return page;
    if (
      cursorValue !== null &&
      cursorValue.catalogRevision !== page.value.catalogRevision
    ) {
      return failure("SourceCursorStale");
    }
    const items = page.value.items.slice(0, input.value.limit);
    const tail = items.at(-1);
    let nextCursor = null;
    if (page.value.items.length > input.value.limit && tail !== undefined) {
      const encoded = await this.#dependencies.cursorCodec.encode({
        ownerId: input.value.ownerId,
        approvedAt: tail.approvedAt,
        sourceId: tail.id,
        catalogRevision: page.value.catalogRevision,
      });
      if (!encoded.ok) return encoded;
      nextCursor = encoded.value;
    }
    return {
      ok: /** @type {const} */ (true),
      value: freeze({
        items: freeze(items),
        interestAreas: page.value.interestAreas,
        nextCursor,
      }),
    };
  }

  /** @param {unknown} command @returns {Promise<Result<readonly SourceSearchHit[], SourceLibraryFailure>>} */
  async search(command) {
    const input = validateSearch(
      command,
      this.#dependencies.maximumPageSize,
      this.#dependencies.maximumQueryLength,
    );
    if (!input.ok) return input;
    if (input.value.mode === "keyword") {
      return await this.#dependencies.repository.keywordSearch(input.value);
    }
    const semantic = await this.#semantic(input.value);
    if (!semantic.ok || input.value.mode === "semantic") return semantic;
    const keyword = await this.#dependencies.repository.keywordSearch(
      input.value,
    );
    if (!keyword.ok) return keyword;
    return {
      ok: /** @type {const} */ (true),
      value: fuse(keyword.value, semantic.value, input.value.limit),
    };
  }

  /** @param {unknown} command @returns {Promise<Result<readonly string[], SourceLibraryFailure>>} */
  async suppressed(command) {
    if (
      !isRecord(command) || !isNonEmptyText(command.ownerId) ||
      !Array.isArray(command.canonicalIdentities) ||
      command.canonicalIdentities.length < 1 ||
      command.canonicalIdentities.length > 50 ||
      command.canonicalIdentities.some((value) => !isNonEmptyText(value))
    ) {
      return invalidCommand("canonicalIdentities");
    }
    const canonicalIdentities = [
      ...new Set(
        command.canonicalIdentities.map((value) =>
          /** @type {string} */ (value).trim()
        ),
      ),
    ];
    return await this.#dependencies.repository.suppressed({
      ownerId: command.ownerId.trim(),
      canonicalIdentities,
    });
  }

  /** @param {unknown} command @returns {Promise<Result<readonly string[], SourceLibraryFailure>>} */
  async active(command) {
    if (
      !isRecord(command) || !isNonEmptyText(command.ownerId) ||
      !Array.isArray(command.sourceIds) || command.sourceIds.length < 1 ||
      command.sourceIds.length > 50 ||
      command.sourceIds.some((value) => !isNonEmptyText(value))
    ) {
      return invalidCommand("sourceIds");
    }
    const sourceIds = [
      ...new Set(
        command.sourceIds.map((value) => /** @type {string} */ (value).trim()),
      ),
    ];
    const active = await this.#dependencies.repository.activeByIds({
      ownerId: command.ownerId.trim(),
      sourceIds,
    });
    return active.ok
      ? {
        ok: /** @type {const} */ (true),
        value: freeze(active.value.map((source) => source.id)),
      }
      : active;
  }

  /** @param {{ readonly ownerId: string, readonly query: string, readonly limit: number, readonly mode: SourceSearchMode }} input */
  async #semantic(input) {
    const embedded = await this.#dependencies.embedding.create(input.query);
    if (!embedded.ok) return embedded;
    if (
      embedded.value.dimensions !== embedded.value.vector.length ||
      embedded.value.vector.some((value) => !Number.isFinite(value))
    ) {
      return failure("SourceEmbeddingDimensionMismatch");
    }
    const indexed = await this.#dependencies.semanticIndex.search({
      ownerId: input.ownerId,
      vector: embedded.value.vector,
      modelId: embedded.value.modelId,
      modelVersion: embedded.value.modelVersion,
      dimensions: embedded.value.dimensions,
      limit: input.limit,
    });
    if (!indexed.ok) return indexed;
    for (const hit of indexed.value) {
      if (
        hit.ownerId !== input.ownerId ||
        hit.modelId !== embedded.value.modelId ||
        hit.modelVersion !== embedded.value.modelVersion
      ) {
        return failure("SourceEmbeddingModelMismatch");
      }
      if (hit.dimensions !== embedded.value.dimensions) {
        return failure("SourceEmbeddingDimensionMismatch");
      }
    }
    const sourceIds = indexed.value.map((hit) => hit.sourceId);
    const active = await this.#dependencies.repository.activeByIds({
      ownerId: input.ownerId,
      sourceIds,
    });
    if (!active.ok) return active;
    const sources = new Map(active.value.map((source) => [source.id, source]));
    if (sources.size !== new Set(sourceIds).size) {
      return failure("SourceSemanticIndexOutOfSync");
    }
    return {
      ok: /** @type {const} */ (true),
      value: freeze(indexed.value.map((hit) =>
        freeze({
          source: /** @type {LibrarySource} */ (sources.get(hit.sourceId)),
          score: hit.score,
        })
      )),
    };
  }
}

/** @param {unknown} command @param {number} maximum @returns {Result<ValidatedBrowse, SourceLibraryFailure>} */
function validateBrowse(command, maximum) {
  if (!isRecord(command) || !isNonEmptyText(command.ownerId)) {
    return invalidCommand("ownerId");
  }
  if (
    typeof command.limit !== "number" || !Number.isInteger(command.limit) ||
    command.limit < 1 || command.limit > maximum
  ) {
    return invalidCommand("limit");
  }
  if (
    command.cursor !== undefined && command.cursor !== null &&
    !isNonEmptyText(command.cursor)
  ) {
    return failure("SourceCursorInvalid");
  }
  return {
    ok: /** @type {const} */ (true),
    value: freeze({
      ownerId: command.ownerId.trim(),
      limit: command.limit,
      cursor: command.cursor === undefined ? null : command.cursor,
    }),
  };
}

/** @param {unknown} command @param {number} maximumPageSize @param {number} maximumQueryLength @returns {Result<ValidatedSearch, SourceLibraryFailure>} */
function validateSearch(command, maximumPageSize, maximumQueryLength) {
  if (!isRecord(command) || !isNonEmptyText(command.ownerId)) {
    return invalidCommand("ownerId");
  }
  if (!isNonEmptyText(command.query)) {
    return failure("SourceSearchQueryInvalid");
  }
  const query = command.query.trim();
  if (query.length > maximumQueryLength) {
    return {
      ok: /** @type {const} */ (false),
      error: {
        kind: /** @type {const} */ ("SourceSearchQueryTooLong"),
        maximum: maximumQueryLength,
      },
    };
  }
  if (
    command.mode !== "keyword" && command.mode !== "semantic" &&
    command.mode !== "combined"
  ) {
    return invalidCommand("mode");
  }
  if (
    typeof command.limit !== "number" || !Number.isInteger(command.limit) ||
    command.limit < 1 || command.limit > maximumPageSize
  ) {
    return invalidCommand("limit");
  }
  return {
    ok: /** @type {const} */ (true),
    value: freeze({
      ownerId: command.ownerId.trim(),
      query,
      mode: command.mode,
      limit: command.limit,
    }),
  };
}

/** @param {readonly SourceSearchHit[]} keyword @param {readonly SourceSearchHit[]} semantic @param {number} limit */
function fuse(keyword, semantic, limit) {
  /** @type {Map<string, { source: LibrarySource, score: number }>} */
  const ranked = new Map();
  /** @param {readonly SourceSearchHit[]} list */
  const add = (list) => {
    for (let index = 0; index < list.length; index++) {
      const hit = list[index];
      const prior = ranked.get(hit.source.id);
      const score = 1 / (60 + index + 1);
      ranked.set(hit.source.id, {
        source: hit.source,
        score: (prior?.score ?? 0) + score,
      });
    }
  };
  add(keyword);
  add(semantic);
  return freeze(
    [...ranked.values()].sort((left, right) =>
      right.score - left.score ||
      right.source.approvedAt.localeCompare(left.source.approvedAt) ||
      right.source.id.localeCompare(left.source.id)
    ).slice(0, limit).map((hit) => freeze(hit)),
  );
}

/** @param {string} field @returns {Result<never, Extract<SourceLibraryFailure, { readonly kind: "SourceCatalogCommandInvalid" }>>} */
function invalidCommand(field) {
  return {
    ok: /** @type {const} */ (false),
    error: {
      kind: /** @type {const} */ ("SourceCatalogCommandInvalid"),
      field,
    },
  };
}

/** @template {SourceLibraryFailure["kind"]} K @param {K} kind */
function failure(kind) {
  return /** @type {Result<never, Extract<SourceLibraryFailure, { readonly kind: K }>>} */ ({
    ok: false,
    error: { kind },
  });
}

export {};
