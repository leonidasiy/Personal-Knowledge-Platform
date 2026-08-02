// @ts-check

/**
 * @template T
 * @template E
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result
 */

/** @typedef {"storage" | "display" | "transformation" | "attribution"} TranscriptCapability */
/** @typedef {"allowed" | "denied" | "unknown"} TranscriptCapabilityStatus */

/**
 * @typedef {{
 *   readonly requestId: string,
 *   readonly transcriptUrl: string,
 *   readonly language: string,
 *   readonly rights: {
 *     readonly evidenceId: string,
 *     readonly storage: TranscriptCapabilityStatus,
 *     readonly display: TranscriptCapabilityStatus,
 *     readonly transformation: TranscriptCapabilityStatus,
 *     readonly attribution: TranscriptCapabilityStatus,
 *     readonly attributionText: string,
 *     readonly expiresAt: string,
 *   },
 *   readonly jsonTextPath: readonly string[] | null,
 *   readonly retention: {
 *     readonly mode: "plain-text",
 *   } | {
 *     readonly mode: "excerpt",
 *     readonly startCharacter: number,
 *     readonly characterCount: number,
 *   },
 * }} PublisherTranscriptCommand
 */

/**
 * @typedef {{
 *   readonly submittedUrl: string,
 *   readonly canonicalUrl: string,
 *   readonly redirects: readonly string[],
 *   readonly mediaType: "text/plain" | "text/vtt" | "application/x-subrip" | "application/json" | "text/html",
 *   readonly language: string,
 *   readonly text: string,
 *   readonly retentionMode: "plain-text" | "excerpt",
 *   readonly byteCount: number,
 *   readonly digest: string,
 *   readonly retrievedAt: string,
 *   readonly rightsEvidenceId: string,
 *   readonly rightsExpiresAt: string,
 *   readonly attributionText: string,
 * }} PublisherTranscriptResult
 */

/**
 * @typedef {{ readonly kind: "PodcastTranscriptCommandInvalid", readonly field: string }
 * | { readonly kind: "PodcastTranscriptMissing" }
 * | { readonly kind: "TranscriptRightsUnknown", readonly capability: TranscriptCapability }
 * | { readonly kind: "TranscriptStorageNotPermitted" }
 * | { readonly kind: "TranscriptDisplayNotPermitted" }
 * | { readonly kind: "TranscriptTransformationNotPermitted" }
 * | { readonly kind: "TranscriptAttributionMissing" }
 * | { readonly kind: "TranscriptRightsExpired" }
 * | { readonly kind: "PodcastTranscriptTypeUnsupported", readonly mediaType: string }
 * | { readonly kind: "PodcastTranscriptLanguageUnsupported", readonly language: string }
 * | { readonly kind: "PodcastTranscriptFetchFailed" }
 * | { readonly kind: "PodcastTranscriptTooLarge", readonly limit: number, readonly unit: "bytes" | "characters" }
 * | { readonly kind: "PodcastTranscriptMalformed" }
 * | { readonly kind: "PodcastTranscriptTimestampInvalid" }
 * | { readonly kind: "PodcastTranscriptDigestFailed" }} PublisherTranscriptFailure
 */

/**
 * @typedef {{
 *   readonly maximumBytes: number,
 *   readonly maximumRedirects: number,
 *   readonly maximumTextCharacters: number,
 *   readonly maximumExcerptCharacters: number,
 *   readonly supportedLanguages: ReadonlySet<string>,
 * }} PublisherTranscriptLimits
 */

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MEDIA_TYPES = /** @type {const} */ ([
  "text/plain",
  "text/vtt",
  "application/x-subrip",
  "application/json",
  "text/html",
]);

export class PublisherTranscriptAdapter {
  /** @type {typeof fetch} */
  #fetch;
  /** @type {(url: string) => Result<URL, { readonly kind: "DestinationRejected" }>} */
  #validateDestination;
  /** @type {() => Date} */
  #clock;
  /** @type {(bytes: Uint8Array) => Promise<Result<string, { readonly kind: "DigestUnavailable" }>>} */
  #digest;
  /** @type {PublisherTranscriptLimits} */
  #limits;

  /**
   * @param {{
   *   readonly fetch: typeof fetch,
   *   readonly validateDestination: (url: string) => Result<URL, { readonly kind: "DestinationRejected" }>,
   *   readonly clock: () => Date,
   *   readonly digest: (bytes: Uint8Array) => Promise<Result<string, { readonly kind: "DigestUnavailable" }>>,
   *   readonly limits: PublisherTranscriptLimits,
   * }} dependencies
   */
  constructor(dependencies) {
    if (
      typeof dependencies.fetch !== "function" ||
      typeof dependencies.validateDestination !== "function" ||
      typeof dependencies.clock !== "function" ||
      typeof dependencies.digest !== "function" ||
      !positiveInteger(dependencies.limits.maximumBytes) ||
      !nonNegativeInteger(dependencies.limits.maximumRedirects) ||
      !positiveInteger(dependencies.limits.maximumTextCharacters) ||
      !positiveInteger(dependencies.limits.maximumExcerptCharacters) ||
      !(dependencies.limits.supportedLanguages instanceof Set)
    ) {
      throw new TypeError("Publisher transcript dependencies are invalid.");
    }
    this.#fetch = dependencies.fetch;
    this.#validateDestination = dependencies.validateDestination;
    this.#clock = dependencies.clock;
    this.#digest = dependencies.digest;
    this.#limits = Object.freeze({ ...dependencies.limits });
  }

  /**
   * @param {unknown} input
   * @returns {Promise<Result<PublisherTranscriptResult, PublisherTranscriptFailure>>}
   */
  async retrieve(input) {
    const command = validateCommand(input);
    if (!command.ok) return command;
    const authorized = validateRights(command.value, this.#clock());
    if (!authorized.ok) return authorized;
    if (!this.#limits.supportedLanguages.has(command.value.language)) {
      return {
        ok: false,
        error: {
          kind: "PodcastTranscriptLanguageUnsupported",
          language: command.value.language,
        },
      };
    }
    if (
      command.value.retention.mode === "excerpt" &&
      command.value.retention.characterCount >
        this.#limits.maximumExcerptCharacters
    ) {
      return {
        ok: false,
        error: {
          kind: "PodcastTranscriptTooLarge",
          limit: this.#limits.maximumExcerptCharacters,
          unit: "characters",
        },
      };
    }

    const submitted = this.#validateDestination(command.value.transcriptUrl);
    if (!submitted.ok) {
      return { ok: false, error: { kind: "PodcastTranscriptFetchFailed" } };
    }
    /** @type {string[]} */
    const redirects = [];
    let current = submitted.value;
    for (
      let attempt = 0;
      attempt <= this.#limits.maximumRedirects;
      attempt += 1
    ) {
      /** @type {Response} */
      let response;
      try {
        response = await this.#fetch(current, {
          method: "GET",
          redirect: "manual",
          headers: {
            accept:
              "text/plain, text/vtt, application/x-subrip, application/json, text/html",
          },
        });
      } catch (_error) {
        return {
          ok: false,
          error: { kind: "PodcastTranscriptFetchFailed" },
        };
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        if (attempt === this.#limits.maximumRedirects) {
          return {
            ok: false,
            error: { kind: "PodcastTranscriptFetchFailed" },
          };
        }
        const location = response.headers.get("location");
        if (location === null || !URL.canParse(location, current)) {
          return {
            ok: false,
            error: { kind: "PodcastTranscriptFetchFailed" },
          };
        }
        const next = this.#validateDestination(
          new URL(location, current).href,
        );
        if (!next.ok) {
          return {
            ok: false,
            error: { kind: "PodcastTranscriptFetchFailed" },
          };
        }
        redirects.push(next.value.href);
        current = next.value;
        continue;
      }
      if (response.status === 404 || response.status === 410) {
        return { ok: false, error: { kind: "PodcastTranscriptMissing" } };
      }
      if (!response.ok) {
        return {
          ok: false,
          error: { kind: "PodcastTranscriptFetchFailed" },
        };
      }
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0]
        .trim().toLowerCase() ?? "";
      if (!isMediaType(mediaType)) {
        return {
          ok: false,
          error: { kind: "PodcastTranscriptTypeUnsupported", mediaType },
        };
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > this.#limits.maximumBytes
      ) {
        return tooLarge(this.#limits.maximumBytes, "bytes");
      }
      const body = await readBounded(response, this.#limits.maximumBytes);
      if (!body.ok) return body;
      const digested = await this.#digest(body.value);
      if (!digested.ok) {
        return {
          ok: false,
          error: { kind: "PodcastTranscriptDigestFailed" },
        };
      }
      let decoded;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(body.value);
      } catch (error) {
        if (error instanceof TypeError) {
          return {
            ok: false,
            error: { kind: "PodcastTranscriptMalformed" },
          };
        }
        throw error;
      }
      const extracted = extractPlainText(
        mediaType,
        decoded,
        command.value.jsonTextPath,
      );
      if (!extracted.ok) return extracted;
      const normalized = normalizeText(extracted.value);
      if (normalized === "") {
        return {
          ok: false,
          error: { kind: "PodcastTranscriptMalformed" },
        };
      }
      const retained = selectRetention(
        normalized,
        command.value.retention,
        this.#limits,
      );
      if (!retained.ok) return retained;
      return {
        ok: true,
        value: Object.freeze({
          submittedUrl: submitted.value.href,
          canonicalUrl: current.href,
          redirects: Object.freeze(redirects),
          mediaType,
          language: command.value.language,
          text: retained.value,
          retentionMode: command.value.retention.mode,
          byteCount: body.value.byteLength,
          digest: digested.value,
          retrievedAt: this.#clock().toISOString(),
          rightsEvidenceId: command.value.rights.evidenceId,
          rightsExpiresAt: command.value.rights.expiresAt,
          attributionText: command.value.rights.attributionText,
        }),
      };
    }
    return { ok: false, error: { kind: "PodcastTranscriptFetchFailed" } };
  }
}

/**
 * @param {unknown} value
 * @returns {Result<PublisherTranscriptCommand, PublisherTranscriptFailure>}
 */
function validateCommand(value) {
  if (!isRecord(value)) return invalid("body");
  if (value.transcriptUrl === undefined || value.transcriptUrl === null) {
    return { ok: false, error: { kind: "PodcastTranscriptMissing" } };
  }
  for (const field of ["requestId", "transcriptUrl", "language"]) {
    if (!nonBlank(value[field])) return invalid(field);
  }
  if (!isRecord(value.rights)) return invalid("rights");
  const rights = value.rights;
  if (!nonBlank(rights.evidenceId)) return invalid("rights.evidenceId");
  for (
    const field of ["storage", "display", "transformation", "attribution"]
  ) {
    if (!isCapabilityStatus(rights[field])) return invalid(`rights.${field}`);
  }
  if (!nonBlank(rights.attributionText)) {
    return invalid("rights.attributionText");
  }
  if (!nonBlank(rights.expiresAt)) return invalid("rights.expiresAt");
  const jsonTextPath = value.jsonTextPath === null
    ? null
    : Array.isArray(value.jsonTextPath) && value.jsonTextPath.length > 0 &&
        value.jsonTextPath.every(nonBlank)
    ? Object.freeze([...value.jsonTextPath])
    : undefined;
  if (jsonTextPath === undefined) return invalid("jsonTextPath");
  if (!isRecord(value.retention)) return invalid("retention");
  if (value.retention.mode === "plain-text") {
    return {
      ok: true,
      value: /** @type {PublisherTranscriptCommand} */ ({
        ...value,
        jsonTextPath,
        retention: Object.freeze({ mode: "plain-text" }),
      }),
    };
  }
  if (
    value.retention.mode !== "excerpt" ||
    !nonNegativeInteger(value.retention.startCharacter) ||
    !positiveInteger(value.retention.characterCount)
  ) {
    return invalid("retention");
  }
  return {
    ok: true,
    value: /** @type {PublisherTranscriptCommand} */ ({
      ...value,
      jsonTextPath,
      retention: Object.freeze({
        mode: "excerpt",
        startCharacter: value.retention.startCharacter,
        characterCount: value.retention.characterCount,
      }),
    }),
  };
}

/**
 * @param {PublisherTranscriptCommand} command
 * @param {Date} now
 * @returns {Result<true, PublisherTranscriptFailure>}
 */
function validateRights(command, now) {
  if (!Number.isFinite(now.getTime())) {
    return { ok: false, error: { kind: "PodcastTranscriptTimestampInvalid" } };
  }
  for (
    const capability of /** @type {const} */ ([
      "storage",
      "display",
      "transformation",
      "attribution",
    ])
  ) {
    if (command.rights[capability] === "unknown") {
      return {
        ok: false,
        error: { kind: "TranscriptRightsUnknown", capability },
      };
    }
  }
  if (command.rights.storage !== "allowed") {
    return { ok: false, error: { kind: "TranscriptStorageNotPermitted" } };
  }
  if (command.rights.display !== "allowed") {
    return { ok: false, error: { kind: "TranscriptDisplayNotPermitted" } };
  }
  if (command.rights.transformation !== "allowed") {
    return {
      ok: false,
      error: { kind: "TranscriptTransformationNotPermitted" },
    };
  }
  if (command.rights.attribution !== "allowed") {
    return { ok: false, error: { kind: "TranscriptAttributionMissing" } };
  }
  const expiresAt = Date.parse(command.rights.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return { ok: false, error: { kind: "PodcastTranscriptTimestampInvalid" } };
  }
  if (expiresAt <= now.getTime()) {
    return { ok: false, error: { kind: "TranscriptRightsExpired" } };
  }
  return { ok: true, value: true };
}

/**
 * @param {Response} response
 * @param {number} maximumBytes
 * @returns {Promise<Result<Uint8Array, PublisherTranscriptFailure>>}
 */
async function readBounded(response, maximumBytes) {
  if (response.body === null) {
    return {
      ok: false,
      error: { kind: "PodcastTranscriptMalformed" },
    };
  }
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let byteCount = 0;
  while (true) {
    let next;
    try {
      next = await reader.read();
    } catch (_error) {
      return {
        ok: false,
        error: { kind: "PodcastTranscriptFetchFailed" },
      };
    }
    if (next.done) break;
    byteCount += next.value.byteLength;
    if (byteCount > maximumBytes) {
      try {
        await reader.cancel();
      } catch (_error) {
        return {
          ok: false,
          error: { kind: "PodcastTranscriptFetchFailed" },
        };
      }
      return tooLarge(maximumBytes, "bytes");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, value: bytes };
}

/**
 * @param {PublisherTranscriptResult["mediaType"]} mediaType
 * @param {string} documentText
 * @param {readonly string[] | null} jsonTextPath
 * @returns {Result<string, PublisherTranscriptFailure>}
 */
function extractPlainText(mediaType, documentText, jsonTextPath) {
  if (mediaType === "text/plain") return { ok: true, value: documentText };
  if (mediaType === "text/vtt") {
    return extractTimedText(documentText, "vtt");
  }
  if (mediaType === "application/x-subrip") {
    return extractTimedText(documentText, "srt");
  }
  if (mediaType === "application/json") {
    if (jsonTextPath === null) {
      return {
        ok: false,
        error: { kind: "PodcastTranscriptMalformed" },
      };
    }
    /** @type {unknown} */
    let value;
    try {
      value = JSON.parse(documentText);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return {
          ok: false,
          error: { kind: "PodcastTranscriptMalformed" },
        };
      }
      throw error;
    }
    for (const segment of jsonTextPath) {
      if (!isRecord(value) || !(segment in value)) {
        return {
          ok: false,
          error: { kind: "PodcastTranscriptMalformed" },
        };
      }
      value = value[segment];
    }
    return typeof value === "string"
      ? { ok: true, value }
      : { ok: false, error: { kind: "PodcastTranscriptMalformed" } };
  }
  return extractHtmlText(documentText);
}

/**
 * @param {string} text
 * @param {"vtt" | "srt"} format
 * @returns {Result<string, PublisherTranscriptFailure>}
 */
function extractTimedText(text, format) {
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
    .split("\n");
  if (format === "vtt" && lines[0]?.trim() !== "WEBVTT") {
    return { ok: false, error: { kind: "PodcastTranscriptMalformed" } };
  }
  let timestampCount = 0;
  /** @type {string[]} */
  const content = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed === "WEBVTT" || /^\d+$/.test(trimmed)) {
      continue;
    }
    if (trimmed.includes("-->")) {
      if (!validTimestampLine(trimmed, format)) {
        return {
          ok: false,
          error: { kind: "PodcastTranscriptTimestampInvalid" },
        };
      }
      timestampCount += 1;
      continue;
    }
    content.push(stripTags(trimmed));
  }
  return timestampCount > 0
    ? { ok: true, value: content.join("\n") }
    : { ok: false, error: { kind: "PodcastTranscriptMalformed" } };
}

/** @param {string} html @returns {Result<string, PublisherTranscriptFailure>} */
function extractHtmlText(html) {
  if (html.includes("\0")) {
    return { ok: false, error: { kind: "PodcastTranscriptMalformed" } };
  }
  const withoutNonContent = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|template|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      " ",
    );
  return { ok: true, value: stripTags(withoutNonContent) };
}

/** @param {string} value */
function stripTags(value) {
  return value.replace(/<[^>]*>/g, " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

/** @param {string} value */
function normalizeText(value) {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
    .split("\n").map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "").join("\n").trim();
}

/** @param {string} line @param {"vtt" | "srt"} format */
function validTimestampLine(line, format) {
  const match = format === "vtt"
    ? line.match(
      /^((?:\d{2}:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d{2}:)?\d{2}:\d{2}\.\d{3})(?:\s+.*)?$/,
    )
    : line.match(
      /^(\d{2}:\d{2}:\d{2},\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2},\d{3})(?:\s+.*)?$/,
    );
  if (match === null) return false;
  const start = timestampMilliseconds(match[1], format);
  const end = timestampMilliseconds(match[2], format);
  return start !== null && end !== null && end > start;
}

/** @param {string} value @param {"vtt" | "srt"} format */
function timestampMilliseconds(value, format) {
  const normalized = format === "srt" ? value.replace(",", ".") : value;
  const [clock, fraction] = normalized.split(".");
  const components = clock.split(":").map(Number);
  if (
    fraction.length !== 3 ||
    (components.length !== 2 && components.length !== 3) ||
    components.some((component) => !Number.isInteger(component))
  ) return null;
  const seconds = components.at(-1) ?? 0;
  const minutes = components.at(-2) ?? 0;
  const hours = components.length === 3 ? components[0] : 0;
  if (seconds > 59 || minutes > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000 + Number(fraction);
}

/**
 * @param {string} text
 * @param {PublisherTranscriptCommand["retention"]} retention
 * @param {PublisherTranscriptLimits} limits
 * @returns {Result<string, PublisherTranscriptFailure>}
 */
function selectRetention(text, retention, limits) {
  if (retention.mode === "plain-text") {
    return text.length <= limits.maximumTextCharacters
      ? { ok: true, value: text }
      : tooLarge(limits.maximumTextCharacters, "characters");
  }
  if (retention.startCharacter >= text.length) {
    return { ok: false, error: { kind: "PodcastTranscriptMalformed" } };
  }
  const excerpt = text.slice(
    retention.startCharacter,
    retention.startCharacter + retention.characterCount,
  ).trim();
  return excerpt === ""
    ? { ok: false, error: { kind: "PodcastTranscriptMalformed" } }
    : { ok: true, value: excerpt };
}

/** @param {unknown} value @returns {value is TranscriptCapabilityStatus} */
function isCapabilityStatus(value) {
  return value === "allowed" || value === "denied" || value === "unknown";
}

/** @param {string} value @returns {value is PublisherTranscriptResult["mediaType"]} */
function isMediaType(value) {
  return MEDIA_TYPES.some((mediaType) => mediaType === value);
}

/**
 * @param {number} limit
 * @param {"bytes" | "characters"} unit
 * @returns {Result<never, PublisherTranscriptFailure>}
 */
function tooLarge(limit, unit) {
  return {
    ok: false,
    error: { kind: "PodcastTranscriptTooLarge", limit, unit },
  };
}

/** @param {string} field @returns {Result<never, PublisherTranscriptFailure>} */
function invalid(field) {
  return {
    ok: false,
    error: { kind: "PodcastTranscriptCommandInvalid", field },
  };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function nonBlank(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** @param {unknown} value */
function positiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** @param {unknown} value */
function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export {};
