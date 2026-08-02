// @ts-check

/**
 * @template T
 * @template E
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result
 */

/**
 * @typedef {(
 *   { readonly kind: "OAuthInputInvalid", readonly field: string }
 *   | { readonly kind: "OAuthClockInvalid" }
 *   | { readonly kind: "OAuthRandomUnavailable" }
 *   | { readonly kind: "OAuthDigestUnavailable" }
 *   | { readonly kind: "OAuthTransactionPersistenceFailed" }
 *   | { readonly kind: "OAuthTransactionMissing" }
 *   | { readonly kind: "OAuthTransactionOwnerMismatch" }
 *   | { readonly kind: "OAuthTransactionExpired" }
 *   | { readonly kind: "OAuthTokenExchangeUnavailable" }
 *   | { readonly kind: "OAuthTokenExchangeRejected", readonly status: number }
 *   | { readonly kind: "OAuthTokenResponseInvalid", readonly field: string }
 *   | { readonly kind: "OAuthIdTokenVerificationFailed" }
 *   | { readonly kind: "OAuthIdTokenNonceMismatch" }
 *   | { readonly kind: "OAuthGrantedScopeInsufficient", readonly scope: string }
 *   | { readonly kind: "OAuthRefreshTokenMissing" }
 *   | { readonly kind: "OAuthEncryptionKeyUnavailable", readonly keyVersion: string }
 *   | { readonly kind: "OAuthRefreshTokenEncryptionFailed" }
 *   | { readonly kind: "OAuthRefreshTokenDecryptionFailed" }
 *   | { readonly kind: "OAuthConnectionPersistenceFailed" }
 *   | { readonly kind: "OAuthConnectionMissing" }
 *   | { readonly kind: "OAuthConnectionRevoked" }
 *   | { readonly kind: "OAuthProviderRevocationFailed", readonly status: number }
 * )} OAuthFailure
 */

/**
 * @typedef {{
 *   readonly formatVersion: 1,
 *   readonly algorithm: "A256GCM",
 *   readonly keyVersion: string,
 *   readonly iv: string,
 *   readonly ciphertext: string
 * }} RefreshTokenEnvelope
 */

/**
 * @typedef {{
 *   readonly ownerId: string,
 *   readonly stateDigest: string,
 *   readonly codeVerifier: string,
 *   readonly nonce: string,
 *   readonly expiresAt: string
 * }} OAuthTransaction
 */

/**
 * @typedef {{
 *   readonly status: "connected",
 *   readonly ownerId: string,
 *   readonly providerSubject: string,
 *   readonly accountEmail: string,
 *   readonly grantedScopes: readonly string[],
 *   readonly refreshToken: RefreshTokenEnvelope,
 *   readonly connectedAt: string,
 *   readonly updatedAt: string
 * } | {
 *   readonly status: "revoked",
 *   readonly ownerId: string,
 *   readonly revokedAt: string
 * }} StoredConnection
 */

/**
 * @typedef {{
 *   readonly status: "connected",
 *   readonly accountEmail: string,
 *   readonly grantedScopes: readonly string[],
 *   readonly connectedAt: string,
 *   readonly updatedAt: string
 * } | {
 *   readonly status: "revoked",
 *   readonly revokedAt: string
 * }} OAuthConnectionView
 */

/** @typedef {{ readonly accessToken: string, readonly expiresAt: string }} OAuthAccessToken */

/**
 * @typedef {{
 *   readonly authorizationEndpoint: string,
 *   readonly tokenEndpoint: string,
 *   readonly revocationEndpoint: string,
 *   readonly issuer: string,
 *   readonly clientId: string,
 *   readonly clientSecret: string,
 *   readonly redirectUri: string,
 *   readonly requestedScopes: readonly string[],
 *   readonly transactionTtlMs: number,
 *   readonly keyVersion: string,
 *   readonly encryptionKeys: ReadonlyMap<string, CryptoKey>
 * }} OAuthConfiguration
 */

/**
 * @typedef {{
 *   readonly fetch: typeof fetch,
 *   readonly now: () => Date,
 *   readonly subtle: SubtleCrypto,
 *   readonly randomBytes: (length: number) => Uint8Array,
 *   readonly transactions: {
 *     readonly save: (transaction: OAuthTransaction) => Promise<Result<true, OAuthFailure>>,
 *     readonly consume: (input: { readonly stateDigest: string, readonly ownerId: string }) => Promise<Result<OAuthTransaction, OAuthFailure>>
 *   },
 *   readonly connections: {
 *     readonly read: (ownerId: string) => Promise<Result<StoredConnection, OAuthFailure>>,
 *     readonly write: (connection: StoredConnection) => Promise<Result<true, OAuthFailure>>
 *   },
 *   readonly verifyIdToken: (input: {
 *     readonly token: string,
 *     readonly expectedIssuer: string,
 *     readonly expectedAudience: string,
 *     readonly now: Date
 *   }) => Promise<Result<{
 *     readonly subject: string,
 *     readonly email: string,
 *     readonly emailVerified: boolean,
 *     readonly nonce: string
 *   }, { readonly kind: "OAuthIdTokenVerificationFailed" }>>
 * }} OAuthDependencies
 */

export class YouTubeOAuthService {
  /** @type {OAuthConfiguration} */ #configuration;
  /** @type {OAuthDependencies} */ #dependencies;

  /** @param {OAuthConfiguration} configuration @param {OAuthDependencies} dependencies */
  constructor(configuration, dependencies) {
    assertConfiguration(configuration, dependencies);
    this.#configuration = Object.freeze({
      ...configuration,
      requestedScopes: Object.freeze([...configuration.requestedScopes]),
    });
    this.#dependencies = dependencies;
  }

  /** @param {unknown} ownerId @returns {Promise<Result<{ readonly authorizationUrl: string }, OAuthFailure>>} */
  async start(ownerId) {
    const owner = validText(ownerId, "ownerId");
    if (!owner.ok) return owner;
    const now = this.#dependencies.now();
    if (!validDate(now)) {
      return { ok: false, error: { kind: "OAuthClockInvalid" } };
    }
    const state = randomToken(this.#dependencies.randomBytes, 32);
    if (!state.ok) return state;
    const verifier = randomToken(this.#dependencies.randomBytes, 32);
    if (!verifier.ok) return verifier;
    const nonce = randomToken(this.#dependencies.randomBytes, 32);
    if (!nonce.ok) return nonce;
    const stateDigest = await sha256(state.value, this.#dependencies.subtle);
    if (!stateDigest.ok) return stateDigest;
    const challenge = await sha256(verifier.value, this.#dependencies.subtle);
    if (!challenge.ok) return challenge;
    const saved = await this.#dependencies.transactions.save(Object.freeze({
      ownerId: owner.value,
      stateDigest: stateDigest.value,
      codeVerifier: verifier.value,
      nonce: nonce.value,
      expiresAt: new Date(now.getTime() + this.#configuration.transactionTtlMs)
        .toISOString(),
    }));
    if (!saved.ok) return saved;
    const url = new URL(this.#configuration.authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.#configuration.clientId,
      redirect_uri: this.#configuration.redirectUri,
      scope: this.#configuration.requestedScopes.join(" "),
      state: state.value,
      nonce: nonce.value,
      code_challenge: challenge.value,
      code_challenge_method: "S256",
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
    }).toString();
    return {
      ok: true,
      value: Object.freeze({ authorizationUrl: url.toString() }),
    };
  }

  /** @param {unknown} input @returns {Promise<Result<OAuthConnectionView, OAuthFailure>>} */
  async complete(input) {
    const command = callbackCommand(input);
    if (!command.ok) return command;
    const stateDigest = await sha256(
      command.value.state,
      this.#dependencies.subtle,
    );
    if (!stateDigest.ok) return stateDigest;
    const consumed = await this.#dependencies.transactions.consume({
      stateDigest: stateDigest.value,
      ownerId: command.value.ownerId,
    });
    if (!consumed.ok) return consumed;
    if (consumed.value.ownerId !== command.value.ownerId) {
      return { ok: false, error: { kind: "OAuthTransactionOwnerMismatch" } };
    }
    const now = this.#dependencies.now();
    if (!validDate(now)) {
      return { ok: false, error: { kind: "OAuthClockInvalid" } };
    }
    if (
      !validIso(consumed.value.expiresAt) ||
      Date.parse(consumed.value.expiresAt) <= now.getTime()
    ) {
      return { ok: false, error: { kind: "OAuthTransactionExpired" } };
    }
    const exchanged = await this.#requestToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        code: command.value.code,
        code_verifier: consumed.value.codeVerifier,
        redirect_uri: this.#configuration.redirectUri,
      }),
      true,
    );
    if (!exchanged.ok) return exchanged;
    if (exchanged.value.refreshToken === null) {
      return { ok: false, error: { kind: "OAuthRefreshTokenMissing" } };
    }
    if (exchanged.value.idToken === null) {
      return {
        ok: false,
        error: { kind: "OAuthTokenResponseInvalid", field: "id_token" },
      };
    }
    const verified = await this.#dependencies.verifyIdToken({
      token: exchanged.value.idToken,
      expectedIssuer: this.#configuration.issuer,
      expectedAudience: this.#configuration.clientId,
      now,
    });
    if (!verified.ok) return verified;
    if (!validVerifiedIdentity(verified.value)) {
      return { ok: false, error: { kind: "OAuthIdTokenVerificationFailed" } };
    }
    if (verified.value.nonce !== consumed.value.nonce) {
      return { ok: false, error: { kind: "OAuthIdTokenNonceMismatch" } };
    }
    const key = this.#configuration.encryptionKeys.get(
      this.#configuration.keyVersion,
    );
    if (key === undefined) {
      return {
        ok: false,
        error: {
          kind: "OAuthEncryptionKeyUnavailable",
          keyVersion: this.#configuration.keyVersion,
        },
      };
    }
    const encrypted = await encryptRefreshToken({
      ownerId: command.value.ownerId,
      refreshToken: exchanged.value.refreshToken,
      keyVersion: this.#configuration.keyVersion,
      key,
    }, this.#dependencies);
    if (!encrypted.ok) return encrypted;
    const timestamp = now.toISOString();
    /** @type {StoredConnection} */
    const connection = Object.freeze({
      status: "connected",
      ownerId: command.value.ownerId,
      providerSubject: verified.value.subject,
      accountEmail: verified.value.email,
      grantedScopes: exchanged.value.scopes,
      refreshToken: encrypted.value,
      connectedAt: timestamp,
      updatedAt: timestamp,
    });
    const written = await this.#dependencies.connections.write(connection);
    if (!written.ok) return written;
    return { ok: true, value: view(connection) };
  }

  /** @param {unknown} ownerId @returns {Promise<Result<OAuthAccessToken, OAuthFailure>>} */
  async getAccessToken(ownerId) {
    const active = await this.#activeConnection(ownerId);
    if (!active.ok) return active;
    const key = this.#configuration.encryptionKeys.get(
      active.value.refreshToken.keyVersion,
    );
    if (key === undefined) {
      return {
        ok: false,
        error: {
          kind: "OAuthEncryptionKeyUnavailable",
          keyVersion: active.value.refreshToken.keyVersion,
        },
      };
    }
    const decrypted = await decryptRefreshToken({
      ownerId: active.value.ownerId,
      envelope: active.value.refreshToken,
      key,
    }, this.#dependencies);
    if (!decrypted.ok) return decrypted;
    const refreshed = await this.#requestToken(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: decrypted.value,
      }),
      false,
    );
    if (!refreshed.ok) return refreshed;
    const now = this.#dependencies.now();
    if (!validDate(now)) {
      return { ok: false, error: { kind: "OAuthClockInvalid" } };
    }
    return {
      ok: true,
      value: Object.freeze({
        accessToken: refreshed.value.accessToken,
        expiresAt: new Date(
          now.getTime() + refreshed.value.expiresInSeconds * 1_000,
        ).toISOString(),
      }),
    };
  }

  /** @param {unknown} ownerId @returns {Promise<Result<OAuthConnectionView, OAuthFailure>>} */
  async getConnection(ownerId) {
    const owner = validText(ownerId, "ownerId");
    if (!owner.ok) return owner;
    const found = await this.#dependencies.connections.read(owner.value);
    return found.ok ? { ok: true, value: view(found.value) } : found;
  }

  /** @param {unknown} ownerId @returns {Promise<Result<{ readonly status: "revoked", readonly revokedAt: string }, OAuthFailure>>} */
  async revoke(ownerId) {
    const active = await this.#activeConnection(ownerId);
    if (!active.ok) return active;
    const key = this.#configuration.encryptionKeys.get(
      active.value.refreshToken.keyVersion,
    );
    if (key === undefined) {
      return {
        ok: false,
        error: {
          kind: "OAuthEncryptionKeyUnavailable",
          keyVersion: active.value.refreshToken.keyVersion,
        },
      };
    }
    const token = await decryptRefreshToken({
      ownerId: active.value.ownerId,
      envelope: active.value.refreshToken,
      key,
    }, this.#dependencies);
    if (!token.ok) return token;
    let response;
    try {
      response = await this.#dependencies.fetch(
        this.#configuration.revocationEndpoint,
        {
          method: "POST",
          redirect: "error",
          referrerPolicy: "no-referrer",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: token.value }),
        },
      );
    } catch (error) {
      if (error instanceof Error) {
        return { ok: false, error: { kind: "OAuthTokenExchangeUnavailable" } };
      }
      throw error;
    }
    if (!response.ok) {
      return {
        ok: false,
        error: {
          kind: "OAuthProviderRevocationFailed",
          status: response.status,
        },
      };
    }
    const now = this.#dependencies.now();
    if (!validDate(now)) {
      return { ok: false, error: { kind: "OAuthClockInvalid" } };
    }
    /** @type {StoredConnection} */
    const revoked = Object.freeze({
      status: "revoked",
      ownerId: active.value.ownerId,
      revokedAt: now.toISOString(),
    });
    const written = await this.#dependencies.connections.write(revoked);
    if (!written.ok) return written;
    return {
      ok: true,
      value: Object.freeze({ status: "revoked", revokedAt: revoked.revokedAt }),
    };
  }

  /** @param {unknown} ownerId @returns {Promise<Result<Extract<StoredConnection, {status:"connected"}>, OAuthFailure>>} */
  async #activeConnection(ownerId) {
    const owner = validText(ownerId, "ownerId");
    if (!owner.ok) return owner;
    const found = await this.#dependencies.connections.read(owner.value);
    if (!found.ok) return found;
    if (found.value.status === "revoked") {
      return { ok: false, error: { kind: "OAuthConnectionRevoked" } };
    }
    return { ok: true, value: found.value };
  }

  /** @param {URLSearchParams} parameters @param {boolean} requireIdentity @returns {Promise<Result<{ readonly accessToken:string, readonly expiresInSeconds:number, readonly refreshToken:string|null, readonly idToken:string|null, readonly scopes:readonly string[] },OAuthFailure>>} */
  async #requestToken(parameters, requireIdentity) {
    parameters.set("client_id", this.#configuration.clientId);
    parameters.set("client_secret", this.#configuration.clientSecret);
    let response;
    try {
      response = await this.#dependencies.fetch(
        this.#configuration.tokenEndpoint,
        {
          method: "POST",
          redirect: "error",
          referrerPolicy: "no-referrer",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: parameters,
        },
      );
    } catch (error) {
      if (error instanceof Error) {
        return { ok: false, error: { kind: "OAuthTokenExchangeUnavailable" } };
      }
      throw error;
    }
    if (!response.ok) {
      return {
        ok: false,
        error: { kind: "OAuthTokenExchangeRejected", status: response.status },
      };
    }
    let document;
    try {
      document = /** @type {unknown} */ (await response.json());
    } catch (error) {
      if (error instanceof SyntaxError) {
        return {
          ok: false,
          error: { kind: "OAuthTokenResponseInvalid", field: "body" },
        };
      }
      throw error;
    }
    const parsed = tokenResponse(document, requireIdentity);
    if (!parsed.ok) return parsed;
    for (const scope of this.#configuration.requestedScopes) {
      if (!parsed.value.scopes.includes(scope)) {
        return {
          ok: false,
          error: { kind: "OAuthGrantedScopeInsufficient", scope },
        };
      }
    }
    return parsed;
  }
}

/** @param {{readonly ownerId:string,readonly refreshToken:string,readonly keyVersion:string,readonly key:CryptoKey}} input @param {{readonly subtle:SubtleCrypto,readonly randomBytes:(length:number)=>Uint8Array}} dependencies @returns {Promise<Result<RefreshTokenEnvelope,OAuthFailure>>} */
export async function encryptRefreshToken(input, dependencies) {
  const iv = randomBytes(dependencies.randomBytes, 12);
  if (!iv.ok) return iv;
  try {
    const ciphertext = await dependencies.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv.value,
        additionalData: aad(input.ownerId, input.keyVersion),
      },
      input.key,
      new TextEncoder().encode(input.refreshToken),
    );
    return {
      ok: true,
      value: Object.freeze({
        formatVersion: 1,
        algorithm: "A256GCM",
        keyVersion: input.keyVersion,
        iv: base64Url(iv.value),
        ciphertext: base64Url(new Uint8Array(ciphertext)),
      }),
    };
  } catch (error) {
    if (error instanceof Error) {
      return {
        ok: false,
        error: { kind: "OAuthRefreshTokenEncryptionFailed" },
      };
    }
    throw error;
  }
}

/** @param {{readonly ownerId:string,readonly envelope:RefreshTokenEnvelope,readonly key:CryptoKey}} input @param {{readonly subtle:SubtleCrypto}} dependencies @returns {Promise<Result<string,OAuthFailure>>} */
export async function decryptRefreshToken(input, dependencies) {
  try {
    const clear = await dependencies.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(input.envelope.iv),
        additionalData: aad(input.ownerId, input.envelope.keyVersion),
      },
      input.key,
      fromBase64Url(input.envelope.ciphertext),
    );
    const token = new TextDecoder("utf-8", { fatal: true }).decode(clear);
    return token === ""
      ? { ok: false, error: { kind: "OAuthRefreshTokenDecryptionFailed" } }
      : { ok: true, value: token };
  } catch (error) {
    if (error instanceof Error) {
      return {
        ok: false,
        error: { kind: "OAuthRefreshTokenDecryptionFailed" },
      };
    }
    throw error;
  }
}

/** @param {OAuthConfiguration} c @param {OAuthDependencies} d */
function assertConfiguration(c, d) {
  const endpoints = [
    c.authorizationEndpoint,
    c.tokenEndpoint,
    c.revocationEndpoint,
    c.redirectUri,
  ];
  if (
    endpoints.some((value) =>
      typeof value !== "string" || !URL.canParse(value) ||
      new URL(value).protocol !== "https:"
    ) ||
    ![c.issuer, c.clientId, c.clientSecret, c.keyVersion].every((value) =>
      typeof value === "string" && value.trim() !== ""
    ) ||
    !Array.isArray(c.requestedScopes) || c.requestedScopes.length === 0 ||
    !c.requestedScopes.includes("openid") ||
    c.requestedScopes.some((scope) =>
      typeof scope !== "string" || scope.trim() === ""
    ) || new Set(c.requestedScopes).size !== c.requestedScopes.length ||
    !Number.isInteger(c.transactionTtlMs) || c.transactionTtlMs < 60_000 ||
    c.transactionTtlMs > 30 * 60_000 || !(c.encryptionKeys instanceof Map) ||
    typeof d.fetch !== "function" || typeof d.now !== "function" ||
    typeof d.randomBytes !== "function" || !d.subtle ||
    typeof d.transactions?.save !== "function" ||
    typeof d.transactions?.consume !== "function" ||
    typeof d.connections?.read !== "function" ||
    typeof d.connections?.write !== "function" ||
    typeof d.verifyIdToken !== "function"
  ) {
    throw new TypeError("YouTube OAuth configuration is invalid.");
  }
}

/** @param {unknown} value @returns {Result<{readonly ownerId:string,readonly state:string,readonly code:string},OAuthFailure>} */
function callbackCommand(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: { kind: "OAuthInputInvalid", field: "body" } };
  }
  const object =
    /** @type {{ownerId?:unknown,state?:unknown,code?:unknown}} */ (value);
  for (const field of /** @type {const} */ (["ownerId", "state", "code"])) {
    const result = validText(object[field], field);
    if (!result.ok) return result;
  }
  return {
    ok: true,
    value: Object.freeze({
      ownerId: /** @type {string} */ (object.ownerId),
      state: /** @type {string} */ (object.state),
      code: /** @type {string} */ (object.code),
    }),
  };
}

/** @param {unknown} value @param {string} field @returns {Result<string,OAuthFailure>} */
function validText(value, field) {
  return typeof value === "string" && value.trim() !== "" &&
      value.length <= 2048
    ? { ok: true, value }
    : { ok: false, error: { kind: "OAuthInputInvalid", field } };
}

/** @param {unknown} value @param {boolean} requireIdentity @returns {Result<{readonly accessToken:string,readonly expiresInSeconds:number,readonly refreshToken:string|null,readonly idToken:string|null,readonly scopes:readonly string[]},OAuthFailure>} */
function tokenResponse(value, requireIdentity) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: { kind: "OAuthTokenResponseInvalid", field: "body" },
    };
  }
  const v =
    /** @type {{access_token?:unknown,expires_in?:unknown,token_type?:unknown,refresh_token?:unknown,id_token?:unknown,scope?:unknown}} */ (value);
  if (typeof v.access_token !== "string" || v.access_token === "") {
    return {
      ok: false,
      error: { kind: "OAuthTokenResponseInvalid", field: "access_token" },
    };
  }
  if (
    !Number.isInteger(v.expires_in) || /** @type {number} */ (v.expires_in) < 1
  ) {
    return {
      ok: false,
      error: { kind: "OAuthTokenResponseInvalid", field: "expires_in" },
    };
  }
  if (
    typeof v.token_type !== "string" || v.token_type.toLowerCase() !== "bearer"
  ) {
    return {
      ok: false,
      error: { kind: "OAuthTokenResponseInvalid", field: "token_type" },
    };
  }
  if (typeof v.scope !== "string" || v.scope.trim() === "") {
    return {
      ok: false,
      error: { kind: "OAuthTokenResponseInvalid", field: "scope" },
    };
  }
  if (
    v.refresh_token !== undefined &&
    (typeof v.refresh_token !== "string" || v.refresh_token === "")
  ) {
    return {
      ok: false,
      error: { kind: "OAuthTokenResponseInvalid", field: "refresh_token" },
    };
  }
  if (
    requireIdentity && (typeof v.id_token !== "string" || v.id_token === "")
  ) {
    return {
      ok: false,
      error: { kind: "OAuthTokenResponseInvalid", field: "id_token" },
    };
  }
  return {
    ok: true,
    value: Object.freeze({
      accessToken: v.access_token,
      expiresInSeconds: /** @type {number} */ (v.expires_in),
      refreshToken: typeof v.refresh_token === "string"
        ? v.refresh_token
        : null,
      idToken: typeof v.id_token === "string" ? v.id_token : null,
      scopes: Object.freeze([...new Set(v.scope.trim().split(/\s+/))]),
    }),
  };
}

/** @param {{subject:string,email:string,emailVerified:boolean,nonce:string}} value */
function validVerifiedIdentity(value) {
  return typeof value.subject === "string" && value.subject !== "" &&
    typeof value.email === "string" && value.email !== "" &&
    value.emailVerified === true && typeof value.nonce === "string" &&
    value.nonce !== "";
}

/** @param {StoredConnection} connection @returns {OAuthConnectionView} */
function view(connection) {
  return connection.status === "revoked"
    ? Object.freeze({ status: "revoked", revokedAt: connection.revokedAt })
    : Object.freeze({
      status: "connected",
      accountEmail: connection.accountEmail,
      grantedScopes: connection.grantedScopes,
      connectedAt: connection.connectedAt,
      updatedAt: connection.updatedAt,
    });
}

/** @param {string} value @param {SubtleCrypto} subtle @returns {Promise<Result<string,OAuthFailure>>} */
async function sha256(value, subtle) {
  try {
    return {
      ok: true,
      value: base64Url(
        new Uint8Array(
          await subtle.digest("SHA-256", new TextEncoder().encode(value)),
        ),
      ),
    };
  } catch (error) {
    if (error instanceof Error) {
      return { ok: false, error: { kind: "OAuthDigestUnavailable" } };
    }
    throw error;
  }
}

/** @param {(length:number)=>Uint8Array} source @param {number} length @returns {Result<string,OAuthFailure>} */
function randomToken(source, length) {
  const bytes = randomBytes(source, length);
  return bytes.ok ? { ok: true, value: base64Url(bytes.value) } : bytes;
}

/** @param {(length:number)=>Uint8Array} source @param {number} length @returns {Result<Uint8Array,OAuthFailure>} */
function randomBytes(source, length) {
  try {
    const value = source(length);
    return value instanceof Uint8Array && value.length === length
      ? { ok: true, value }
      : { ok: false, error: { kind: "OAuthRandomUnavailable" } };
  } catch (error) {
    if (error instanceof Error) {
      return { ok: false, error: { kind: "OAuthRandomUnavailable" } };
    }
    throw error;
  }
}

/** @param {string} ownerId @param {string} keyVersion */
function aad(ownerId, keyVersion) {
  return new TextEncoder().encode(
    JSON.stringify(["youtube-oauth-refresh-token", 1, ownerId, keyVersion]),
  );
}

/** @param {Uint8Array} bytes */
function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}

/** @param {string} value */
function fromBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** @param {Date} date */
function validDate(date) {
  return date instanceof Date && Number.isFinite(date.getTime());
}

/** @param {string} value */
function validIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export {};
