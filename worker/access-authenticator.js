// @ts-check

/** @import { AccessIdentity, Result, WorkerFailure } from "./contracts.js" */

/**
 * @typedef {{
 *   readonly alg: string,
 *   readonly kid: string
 * }} JwtHeader
 */

/**
 * @typedef {{
 *   readonly iss: string,
 *   readonly aud: string | readonly string[],
 *   readonly exp: number,
 *   readonly nbf: number | null,
 *   readonly email: string
 * }} AccessClaims
 */

export class CloudflareAccessAuthenticator {
  /** @type {{ readonly issuer: string, readonly audience: string, readonly ownerByEmail: ReadonlyMap<string, string> }} */
  #configuration;
  /** @type {{ readonly nowEpochSeconds: () => number, readonly keyFor: (kid: string) => Promise<Result<JsonWebKey, WorkerFailure>>, readonly verify: (input: { readonly key: JsonWebKey, readonly signingInput: Uint8Array, readonly signature: Uint8Array }) => Promise<boolean> }} */
  #dependencies;

  /**
   * @param {{ readonly issuer: string, readonly audience: string, readonly ownerByEmail: ReadonlyMap<string, string> }} configuration
   * @param {{ readonly nowEpochSeconds: () => number, readonly keyFor: (kid: string) => Promise<Result<JsonWebKey, WorkerFailure>>, readonly verify: (input: { readonly key: JsonWebKey, readonly signingInput: Uint8Array, readonly signature: Uint8Array }) => Promise<boolean> }} dependencies
   */
  constructor(configuration, dependencies) {
    if (
      !URL.canParse(configuration.issuer) ||
      typeof configuration.audience !== "string" ||
      configuration.audience.trim() === "" ||
      !(configuration.ownerByEmail instanceof Map) ||
      typeof dependencies.nowEpochSeconds !== "function" ||
      typeof dependencies.keyFor !== "function" ||
      typeof dependencies.verify !== "function"
    ) {
      throw new TypeError("Cloudflare Access configuration is invalid.");
    }
    this.#configuration = configuration;
    this.#dependencies = dependencies;
  }

  /** @param {Request} request @returns {Promise<Result<AccessIdentity, WorkerFailure>>} */
  async authenticate(request) {
    const token = request.headers.get("cf-access-jwt-assertion");
    if (token === null || token.trim() === "") {
      return { ok: false, error: { kind: "DiscoveryAccessTokenMissing" } };
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
      return { ok: false, error: { kind: "DiscoveryAccessTokenInvalid" } };
    }
    const header = parseHeader(parts[0]);
    const claims = parseClaims(parts[1]);
    const signature = decodeBase64Url(parts[2]);
    if (
      !header.ok || !claims.ok || signature === null ||
      header.value.alg !== "RS256"
    ) {
      return { ok: false, error: { kind: "DiscoveryAccessTokenInvalid" } };
    }
    if (claims.value.iss !== this.#configuration.issuer) {
      return { ok: false, error: { kind: "DiscoveryAccessTokenInvalid" } };
    }
    const audiences = typeof claims.value.aud === "string"
      ? [claims.value.aud]
      : claims.value.aud;
    if (!audiences.includes(this.#configuration.audience)) {
      return { ok: false, error: { kind: "DiscoveryAccessAudienceMismatch" } };
    }
    const now = this.#dependencies.nowEpochSeconds();
    if (
      claims.value.exp <= now ||
      (claims.value.nbf !== null && claims.value.nbf > now)
    ) {
      return { ok: false, error: { kind: "DiscoveryAccessTokenInvalid" } };
    }
    const key = await this.#dependencies.keyFor(header.value.kid);
    if (!key.ok) return key;
    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    if (
      !await this.#dependencies.verify({
        key: key.value,
        signingInput,
        signature,
      })
    ) {
      return { ok: false, error: { kind: "DiscoveryAccessTokenInvalid" } };
    }
    const ownerId = this.#configuration.ownerByEmail.get(claims.value.email);
    if (ownerId === undefined) {
      return { ok: false, error: { kind: "DiscoveryAccessIdentityUnmapped" } };
    }
    return {
      ok: true,
      value: Object.freeze({ ownerId, email: claims.value.email }),
    };
  }
}

/** @param {string} encoded @returns {Result<JwtHeader, WorkerFailure>} */
function parseHeader(encoded) {
  const parsed = parseSegment(encoded);
  if (
    parsed === null || typeof parsed.alg !== "string" ||
    typeof parsed.kid !== "string" || parsed.kid.trim() === ""
  ) return { ok: false, error: { kind: "DiscoveryAccessTokenInvalid" } };
  return { ok: true, value: { alg: parsed.alg, kid: parsed.kid } };
}

/** @param {string} encoded @returns {Result<AccessClaims, WorkerFailure>} */
function parseClaims(encoded) {
  const parsed = parseSegment(encoded);
  if (
    parsed === null || typeof parsed.iss !== "string" ||
    !(typeof parsed.aud === "string" ||
      (Array.isArray(parsed.aud) &&
        parsed.aud.every((entry) => typeof entry === "string"))) ||
    typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp) ||
    !(parsed.nbf === undefined || typeof parsed.nbf === "number") ||
    typeof parsed.email !== "string" || parsed.email.trim() === ""
  ) return { ok: false, error: { kind: "DiscoveryAccessTokenInvalid" } };
  return {
    ok: true,
    value: {
      iss: parsed.iss,
      aud: parsed.aud,
      exp: parsed.exp,
      nbf: typeof parsed.nbf === "number" ? parsed.nbf : null,
      email: parsed.email,
    },
  };
}

/** @param {string} encoded @returns {Record<string, unknown> | null} */
function parseSegment(encoded) {
  const bytes = decodeBase64Url(encoded);
  if (bytes === null) return null;
  try {
    const value =
      /** @type {unknown} */ (JSON.parse(new TextDecoder().decode(bytes)));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? /** @type {Record<string, unknown>} */ (value)
      : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** @param {string} value @returns {Uint8Array | null} */
function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  try {
    return Uint8Array.from(
      atob(padded),
      (character) => character.charCodeAt(0),
    );
  } catch (error) {
    if (error instanceof DOMException) return null;
    throw error;
  }
}
