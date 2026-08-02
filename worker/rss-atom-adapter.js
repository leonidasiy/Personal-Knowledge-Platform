// @ts-check

import { validatePublisherDestination } from "./destination-policy.js";
import { parseNormalizedFeed } from "./feed-parser.js";

/** @import { Result, RssAcquisitionCommand, RssAcquisitionResult, WorkerFailure } from "./contracts.js" */

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class RssAtomAcquisitionAdapter {
  /** @type {typeof fetch} */
  #fetch;
  /** @type {() => string} */
  #now;
  /** @type {(value: Uint8Array) => Promise<Result<string, WorkerFailure>>} */
  #digest;
  /** @type {{ readonly maximumBytes: number, readonly maximumRedirects: number, readonly timeoutMs: number }} */
  #policy;

  /**
   * @param {{
   *   readonly fetch: typeof fetch,
   *   readonly now: () => string,
   *   readonly digest: (value: Uint8Array) => Promise<Result<string, WorkerFailure>>,
   *   readonly policy: { readonly maximumBytes: number, readonly maximumRedirects: number, readonly timeoutMs: number }
   * }} dependencies
   */
  constructor(dependencies) {
    if (
      typeof dependencies.fetch !== "function" ||
      typeof dependencies.now !== "function" ||
      typeof dependencies.digest !== "function" ||
      !Number.isInteger(dependencies.policy.maximumBytes) ||
      dependencies.policy.maximumBytes < 1 ||
      !Number.isInteger(dependencies.policy.maximumRedirects) ||
      dependencies.policy.maximumRedirects < 0 ||
      !Number.isInteger(dependencies.policy.timeoutMs) ||
      dependencies.policy.timeoutMs < 1
    ) {
      throw new TypeError(
        "RssAtomAcquisitionAdapter dependencies are invalid.",
      );
    }
    this.#fetch = dependencies.fetch;
    this.#now = dependencies.now;
    this.#digest = dependencies.digest;
    this.#policy = Object.freeze({ ...dependencies.policy });
  }

  /**
   * @param {RssAcquisitionCommand} command
   * @returns {Promise<Result<RssAcquisitionResult, WorkerFailure>>}
   */
  async acquire(command) {
    const submitted = validatePublisherDestination(command.sourceUrl);
    if (!submitted.ok) return submitted;
    /** @type {string[]} */
    const redirects = [];
    let current = submitted.value;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.#policy.timeoutMs,
    );
    try {
      for (
        let attempt = 0;
        attempt <= this.#policy.maximumRedirects;
        attempt += 1
      ) {
        const headers = new Headers({
          Accept:
            "application/atom+xml, application/rss+xml, application/xml, text/xml",
        });
        if (command.etag !== null) headers.set("If-None-Match", command.etag);
        if (command.lastModified !== null) {
          headers.set("If-Modified-Since", command.lastModified);
        }
        let response;
        try {
          response = await this.#fetch(current, {
            method: "GET",
            headers,
            redirect: "manual",
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted) {
            return { ok: false, error: { kind: "DiscoveryFetchTimedOut" } };
          }
          if (error instanceof Error) {
            return { ok: false, error: { kind: "DiscoveryFetchUnavailable" } };
          }
          throw error;
        }
        if (REDIRECT_STATUSES.has(response.status)) {
          if (attempt === this.#policy.maximumRedirects) {
            return {
              ok: false,
              error: { kind: "DiscoveryRedirectLimitExceeded" },
            };
          }
          const location = response.headers.get("location");
          if (location === null || !URL.canParse(location, current)) {
            return {
              ok: false,
              error: {
                kind: "DiscoveryRedirectRejected",
                location: location ?? "",
              },
            };
          }
          const next = validatePublisherDestination(
            new URL(location, current).href,
          );
          if (!next.ok) {
            return {
              ok: false,
              error: { kind: "DiscoveryRedirectRejected", location },
            };
          }
          redirects.push(next.value.href);
          current = next.value;
          continue;
        }
        if (response.status === 304) {
          return {
            ok: true,
            value: Object.freeze({
              status: "not-modified",
              submittedUrl: submitted.value.href,
              canonicalUrl: current.href,
              retrievedAt: this.#now(),
              redirects: Object.freeze(redirects),
            }),
          };
        }
        if (!response.ok) {
          return {
            ok: false,
            error: { kind: "DiscoveryHttpRejected", status: response.status },
          };
        }
        const mediaType =
          response.headers.get("content-type")?.split(";", 1)[0].trim()
            .toLowerCase() ?? "";
        if (!isXmlMediaType(mediaType)) {
          return {
            ok: false,
            error: { kind: "DiscoveryMediaTypeUnsupported", mediaType },
          };
        }
        const declaredLength = Number(response.headers.get("content-length"));
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > this.#policy.maximumBytes
        ) {
          return {
            ok: false,
            error: {
              kind: "DiscoveryPayloadTooLarge",
              maximumBytes: this.#policy.maximumBytes,
            },
          };
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > this.#policy.maximumBytes) {
          return {
            ok: false,
            error: {
              kind: "DiscoveryPayloadTooLarge",
              maximumBytes: this.#policy.maximumBytes,
            },
          };
        }
        const digest = await this.#digest(bytes);
        if (!digest.ok) return digest;
        let documentText;
        try {
          documentText = new TextDecoder("utf-8", { fatal: true }).decode(
            bytes,
          );
        } catch (error) {
          if (error instanceof TypeError) {
            return {
              ok: false,
              error: { kind: "DiscoveryMediaTypeUnsupported", mediaType },
            };
          }
          throw error;
        }
        const parsed = parseNormalizedFeed(documentText, current.href);
        if (!parsed.ok) return parsed;
        const items = [];
        for (const item of parsed.value.items) {
          const contentDigest = await this.#digest(
            new TextEncoder().encode(stableItemProjection(item)),
          );
          if (!contentDigest.ok) return contentDigest;
          items.push(
            Object.freeze({ ...item, contentDigest: contentDigest.value }),
          );
        }
        return {
          ok: true,
          value: Object.freeze({
            status: "acquired",
            submittedUrl: submitted.value.href,
            canonicalUrl: current.href,
            mediaType,
            byteCount: bytes.byteLength,
            digest: digest.value,
            retrievedAt: this.#now(),
            etag: response.headers.get("etag"),
            lastModified: response.headers.get("last-modified"),
            redirects: Object.freeze(redirects),
            feed: Object.freeze({
              format: parsed.value.format,
              source: parsed.value.source,
              items: Object.freeze(items),
            }),
          }),
        };
      }
      return { ok: false, error: { kind: "DiscoveryRedirectLimitExceeded" } };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** @param {import("./feed-parser.js").ParsedFeedItem} item */
function stableItemProjection(item) {
  return JSON.stringify({
    identityKey: item.identityKey,
    identityEvidence: item.identityEvidence,
    title: item.title,
    canonicalUrl: item.canonicalUrl,
    publisherLabel: item.publisherLabel,
    publishedAt: item.publishedAt,
    podcast: item.podcast,
  });
}

/** @param {string} mediaType */
function isXmlMediaType(mediaType) {
  return mediaType === "application/atom+xml" ||
    mediaType === "application/rss+xml" ||
    mediaType === "application/xml" || mediaType === "text/xml" ||
    mediaType.endsWith("+xml");
}
