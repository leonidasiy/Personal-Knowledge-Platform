// @ts-check

/** @import { OAuthFailure, OAuthTransaction, StoredConnection } from "./youtube-oauth.js" */

/**
 * @template T
 * @template E
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result
 */

/** @typedef {{ readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }} OAuthStoreBinding */
/** @typedef {{ get: (key: string) => Promise<unknown>, put: (key: string, value: unknown) => Promise<void>, delete: (key: string) => Promise<boolean>, transaction: <T>(callback: (transaction: { get: (key: string) => Promise<unknown>, delete: (key: string) => Promise<boolean> }) => Promise<T>) => Promise<T> }} OAuthDurableStorage */

export class DurableYouTubeOAuthStore {
  /** @type {OAuthStoreBinding} */ #binding;

  /** @param {OAuthStoreBinding} binding */
  constructor(binding) {
    if (typeof binding?.fetch !== "function") {
      throw new TypeError("YouTube OAuth store binding is invalid.");
    }
    this.#binding = binding;
    this.transactions = Object.freeze({
      save: (/** @type {OAuthTransaction} */ transaction) =>
        this.#write(
          "/transactions",
          transaction,
          "OAuthTransactionPersistenceFailed",
        ),
      consume: (
        /** @type {{ readonly stateDigest: string, readonly ownerId: string }} */ command,
      ) => this.#consume(command),
    });
    this.connections = Object.freeze({
      read: (/** @type {string} */ ownerId) => this.#readConnection(ownerId),
      write: (/** @type {StoredConnection} */ connection) =>
        this.#write(
          "/connections",
          connection,
          "OAuthConnectionPersistenceFailed",
        ),
    });
  }

  /** @type {{ readonly save: (transaction: OAuthTransaction) => Promise<Result<true, OAuthFailure>>, readonly consume: (command: { readonly stateDigest: string, readonly ownerId: string }) => Promise<Result<OAuthTransaction, OAuthFailure>> }} */
  transactions;
  /** @type {{ readonly read: (ownerId: string) => Promise<Result<StoredConnection, OAuthFailure>>, readonly write: (connection: StoredConnection) => Promise<Result<true, OAuthFailure>> }} */
  connections;

  /** @param {string} path @param {unknown} body @param {"OAuthTransactionPersistenceFailed" | "OAuthConnectionPersistenceFailed"} failureKind */
  async #write(path, body, failureKind) {
    const response = await this.#request(path, "PUT", body);
    return response?.ok
      ? /** @type {const} */ ({ ok: true, value: true })
      : /** @type {const} */ ({ ok: false, error: { kind: failureKind } });
  }

  /** @param {{ readonly stateDigest: string, readonly ownerId: string }} command */
  async #consume(command) {
    const response = await this.#request(
      "/transactions/consume",
      "POST",
      command,
    );
    if (response === null) {
      return /** @type {const} */ ({
        ok: false,
        error: { kind: "OAuthTransactionPersistenceFailed" },
      });
    }
    if (response.status === 404) {
      return /** @type {const} */ ({
        ok: false,
        error: { kind: "OAuthTransactionMissing" },
      });
    }
    if (response.status === 409) {
      return /** @type {const} */ ({
        ok: false,
        error: { kind: "OAuthTransactionOwnerMismatch" },
      });
    }
    const document = await readJson(response);
    return response.ok && isOAuthTransaction(document)
      ? /** @type {const} */ ({ ok: true, value: document })
      : /** @type {const} */ ({
        ok: false,
        error: { kind: "OAuthTransactionPersistenceFailed" },
      });
  }

  /** @param {string} ownerId */
  async #readConnection(ownerId) {
    const response = await this.#request(
      `/connections?ownerId=${encodeURIComponent(ownerId)}`,
      "GET",
    );
    if (response === null) {
      return /** @type {const} */ ({
        ok: false,
        error: { kind: "OAuthConnectionPersistenceFailed" },
      });
    }
    if (response.status === 404) {
      return /** @type {const} */ ({
        ok: false,
        error: { kind: "OAuthConnectionMissing" },
      });
    }
    const document = await readJson(response);
    return response.ok && isStoredConnection(document)
      ? /** @type {const} */ ({ ok: true, value: document })
      : /** @type {const} */ ({
        ok: false,
        error: { kind: "OAuthConnectionPersistenceFailed" },
      });
  }

  /** @param {string} path @param {string} method @param {unknown} [body] */
  async #request(path, method, body) {
    try {
      return await this.#binding.fetch(
        `https://youtube-oauth.internal${path}`,
        {
          method,
          headers: body === undefined
            ? undefined
            : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
    } catch (error) {
      if (error instanceof Error) return null;
      throw error;
    }
  }
}

/**
 * Owner-scoped encrypted OAuth persistence. Callback consumption is executed
 * in a Durable Object transaction so a state value succeeds at most once.
 */
export class YouTubeOAuthDurableObject {
  /** @type {OAuthDurableStorage} */
  #storage;

  /** @param {{ readonly storage: OAuthDurableStorage }} state */
  constructor(state) {
    if (!isStorage(state?.storage)) {
      throw new TypeError("YouTube OAuth Durable Object storage is invalid.");
    }
    this.#storage = state.storage;
  }

  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/transactions" && request.method === "PUT") {
      const body = await readJson(request);
      if (!isOAuthTransaction(body)) return response(400);
      await this.#storage.put(`transaction:${body.stateDigest}`, body);
      return response(204);
    }
    if (url.pathname === "/transactions/consume" && request.method === "POST") {
      const body = await readJson(request);
      if (!isConsumeCommand(body)) return response(400);
      return this.#storage.transaction(async (transaction) => {
        const key = `transaction:${body.stateDigest}`;
        const stored = await transaction.get(key);
        if (!isOAuthTransaction(stored)) return response(404);
        if (stored.ownerId !== body.ownerId) return response(409);
        await transaction.delete(key);
        return json(stored, 200);
      });
    }
    if (url.pathname === "/connections" && request.method === "PUT") {
      const body = await readJson(request);
      if (!isStoredConnection(body)) return response(400);
      await this.#storage.put(`connection:${body.ownerId}`, body);
      return response(204);
    }
    if (url.pathname === "/connections" && request.method === "GET") {
      const ownerId = url.searchParams.get("ownerId");
      if (ownerId === null || ownerId.trim() === "") return response(400);
      const stored = await this.#storage.get(`connection:${ownerId}`);
      return isStoredConnection(stored) ? json(stored, 200) : response(404);
    }
    return response(404);
  }
}

/** @param {Response | Request} response */
async function readJson(response) {
  try {
    return /** @type {unknown} */ (await response.json());
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** @param {unknown} value @returns {value is OAuthTransaction} */
function isOAuthTransaction(value) {
  return isRecord(value) && value.ownerId !== "" &&
    typeof value.ownerId === "string" &&
    typeof value.stateDigest === "string" && value.stateDigest !== "" &&
    typeof value.codeVerifier === "string" && value.codeVerifier !== "" &&
    typeof value.nonce === "string" && value.nonce !== "" &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt));
}

/** @param {unknown} value @returns {value is StoredConnection} */
function isStoredConnection(value) {
  if (
    !isRecord(value) || typeof value.ownerId !== "string" ||
    value.ownerId === ""
  ) return false;
  if (value.status === "revoked") return typeof value.revokedAt === "string";
  return value.status === "connected" &&
    typeof value.providerSubject === "string" &&
    typeof value.accountEmail === "string" &&
    Array.isArray(value.grantedScopes) &&
    value.grantedScopes.every((scope) => typeof scope === "string") &&
    isRecord(value.refreshToken) && value.refreshToken.formatVersion === 1 &&
    value.refreshToken.algorithm === "A256GCM" &&
    typeof value.refreshToken.keyVersion === "string" &&
    typeof value.refreshToken.iv === "string" &&
    typeof value.refreshToken.ciphertext === "string" &&
    typeof value.connectedAt === "string" &&
    typeof value.updatedAt === "string";
}

/** @param {unknown} value @returns {value is { readonly ownerId: string, readonly stateDigest: string }} */
function isConsumeCommand(value) {
  return isRecord(value) &&
    Object.keys(value).sort().join(",") === "ownerId,stateDigest" &&
    typeof value.ownerId === "string" && value.ownerId !== "" &&
    typeof value.stateDigest === "string" && value.stateDigest !== "";
}

/** @param {unknown} value */
function isStorage(value) {
  return isRecord(value) && typeof value.get === "function" &&
    typeof value.put === "function" &&
    typeof value.delete === "function" &&
    typeof value.transaction === "function";
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {number} status */
function response(status) {
  return new Response(null, { status });
}

/** @param {unknown} body @param {number} status */
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
