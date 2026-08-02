// @ts-check

import {
  decryptRefreshToken,
  encryptRefreshToken,
  YouTubeOAuthService,
} from "../worker/youtube-oauth.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

class TransactionStoreFixture {
  /** @type {Map<string, import("../worker/youtube-oauth.js").OAuthTransaction>} */ records =
    new Map();
  /** @type {import("../worker/youtube-oauth.js").OAuthTransaction | null} */ latest =
    null;

  /** @param {import("../worker/youtube-oauth.js").OAuthTransaction} transaction */
  async save(transaction) {
    this.records.set(transaction.stateDigest, transaction);
    this.latest = transaction;
    return /** @type {const} */ ({ ok: true, value: true });
  }

  /** @param {{readonly stateDigest:string,readonly ownerId:string}} input */
  async consume(input) {
    const transaction = this.records.get(input.stateDigest);
    if (transaction === undefined) {
      return /** @type {const} */ ({
        ok: false,
        error: { kind: "OAuthTransactionMissing" },
      });
    }
    if (transaction.ownerId !== input.ownerId) {
      return /** @type {const} */ ({
        ok: false,
        error: { kind: "OAuthTransactionOwnerMismatch" },
      });
    }
    this.records.delete(input.stateDigest);
    return /** @type {const} */ ({ ok: true, value: transaction });
  }
}

class ConnectionStoreFixture {
  /** @type {Map<string, import("../worker/youtube-oauth.js").StoredConnection>} */ records =
    new Map();

  /** @param {string} ownerId */
  async read(ownerId) {
    const value = this.records.get(ownerId);
    return value === undefined
      ? /** @type {const} */ ({
        ok: false,
        error: { kind: "OAuthConnectionMissing" },
      })
      : /** @type {const} */ ({ ok: true, value });
  }

  /** @param {import("../worker/youtube-oauth.js").StoredConnection} connection */
  async write(connection) {
    this.records.set(connection.ownerId, connection);
    return /** @type {const} */ ({ ok: true, value: true });
  }
}

const scopes = Object.freeze([
  "openid",
  "email",
  "https://www.googleapis.com/auth/youtube.readonly",
]);

/** @param {CryptoKey} key */
function configuration(key) {
  return Object.freeze({
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    revocationEndpoint: "https://oauth2.googleapis.com/revoke",
    issuer: "https://accounts.google.com",
    clientId: "client-id.apps.googleusercontent.com",
    clientSecret: "worker-only-client-secret",
    redirectUri: "https://worker.example/api/discovery/youtube/oauth/callback",
    requestedScopes: scopes,
    transactionTtlMs: 10 * 60_000,
    keyVersion: "key-2026-07",
    encryptionKeys: new Map([["key-2026-07", key]]),
  });
}

/** @param {{key:CryptoKey, fetch?:typeof fetch, now?:()=>Date, transactions?:TransactionStoreFixture, connections?:ConnectionStoreFixture, nonce?:()=>string}} options */
function serviceFixture(options) {
  const transactions = options.transactions ?? new TransactionStoreFixture();
  const connections = options.connections ?? new ConnectionStoreFixture();
  let randomCounter = 0;
  const service = new YouTubeOAuthService(configuration(options.key), {
    fetch: options.fetch ?? (async () => Response.error()),
    now: options.now ?? (() => new Date("2026-07-22T00:00:00.000Z")),
    subtle: crypto.subtle,
    randomBytes: (length) => new Uint8Array(length).fill(++randomCounter),
    transactions,
    connections,
    verifyIdToken: async () => ({
      ok: true,
      value: {
        subject: "google-subject-1",
        email: "owner@example.test",
        emailVerified: true,
        nonce: options.nonce?.() ?? transactions.latest?.nonce ?? "missing",
      },
    }),
  });
  return { service, transactions, connections };
}

/** @param {string} body @param {number} [status] */
function json(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** @returns {Promise<CryptoKey>} */
function encryptionKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

Deno.test("OAuth start persists an owner-bound expiring transaction and creates S256 authorization URL", async () => {
  const key = await encryptionKey();
  const { service, transactions } = serviceFixture({ key });
  const started = await service.start("owner-a");
  assertEquals(started.ok, true);
  if (!started.ok) return;
  const url = new URL(started.value.authorizationUrl);
  assertEquals(url.origin, "https://accounts.google.com");
  assertEquals(url.searchParams.get("code_challenge_method"), "S256");
  assertEquals(url.searchParams.get("access_type"), "offline");
  assertEquals(url.searchParams.get("prompt"), "consent");
  assertEquals(url.searchParams.get("scope"), scopes.join(" "));
  const transaction = transactions.latest;
  assert(transaction !== null, "The transaction was not persisted.");
  if (transaction === null) return;
  assertEquals(transaction.ownerId, "owner-a");
  assertEquals(transaction.expiresAt, "2026-07-22T00:10:00.000Z");
  assert(
    transaction.stateDigest !== url.searchParams.get("state"),
    "Raw OAuth state must not be persisted.",
  );
  const expectedChallenge = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(transaction.codeVerifier),
  );
  assertEquals(
    url.searchParams.get("code_challenge"),
    base64Url(new Uint8Array(expectedChallenge)),
  );
  assertEquals(url.searchParams.get("nonce"), transaction.nonce);
});

Deno.test("OAuth callback consumes state once, verifies nonce, and stores only an encrypted refresh token", async () => {
  const key = await encryptionKey();
  /** @type {URLSearchParams | null} */ let submitted = null;
  const fixture = serviceFixture({
    key,
    fetch: /** @type {typeof fetch} */ (async (_input, init) => {
      submitted = /** @type {URLSearchParams} */ (init?.body);
      return json(JSON.stringify({
        access_token: "access-token",
        expires_in: 3600,
        token_type: "Bearer",
        refresh_token: "private-refresh-token",
        id_token: "signed-id-token",
        scope: scopes.join(" "),
      }));
    }),
  });
  const started = await fixture.service.start("owner-a");
  if (!started.ok) throw new Error(started.error.kind);
  const state = new URL(started.value.authorizationUrl).searchParams.get(
    "state",
  );
  if (state === null) throw new Error("Missing state.");
  const completed = await fixture.service.complete({
    ownerId: "owner-a",
    state,
    code: "authorization-code",
  });
  assertEquals(completed.ok, true);
  if (!completed.ok) return;
  assertEquals(completed.value.status, "connected");
  assertEquals(parameters(submitted).get("grant_type"), "authorization_code");
  assertEquals(
    parameters(submitted).get("code_verifier"),
    fixture.transactions.latest?.codeVerifier ?? "",
  );
  const stored = fixture.connections.records.get("owner-a");
  assertEquals(stored?.status, "connected");
  if (stored?.status !== "connected") return;
  assert(
    !JSON.stringify(stored).includes("private-refresh-token"),
    "Refresh token leaked into persisted plaintext.",
  );
  const clear = await decryptRefreshToken({
    ownerId: "owner-a",
    envelope: stored.refreshToken,
    key,
  }, { subtle: crypto.subtle });
  assertEquals(clear.ok, true);
  if (clear.ok) assertEquals(clear.value, "private-refresh-token");
  const replay = await fixture.service.complete({
    ownerId: "owner-a",
    state,
    code: "authorization-code",
  });
  assertEquals(replay.ok, false);
  if (!replay.ok) assertEquals(replay.error.kind, "OAuthTransactionMissing");
});

Deno.test("OAuth callback rejects owner mismatch, expiry, and nonce mismatch before persisting a connection", async () => {
  const key = await encryptionKey();
  let calls = 0;
  const fetched = /** @type {typeof fetch} */ (async () => {
    calls += 1;
    return json(
      JSON.stringify({
        access_token: "a",
        expires_in: 1,
        token_type: "Bearer",
        refresh_token: "r",
        id_token: "id",
        scope: scopes.join(" "),
      }),
    );
  });
  const ownerFixture = serviceFixture({ key, fetch: fetched });
  const ownerStart = await ownerFixture.service.start("owner-a");
  if (!ownerStart.ok) throw new Error(ownerStart.error.kind);
  const ownerState =
    new URL(ownerStart.value.authorizationUrl).searchParams.get("state") ?? "";
  const wrongOwner = await ownerFixture.service.complete({
    ownerId: "owner-b",
    state: ownerState,
    code: "code",
  });
  assertEquals(wrongOwner.ok, false);
  if (!wrongOwner.ok) {
    assertEquals(wrongOwner.error.kind, "OAuthTransactionOwnerMismatch");
  }
  assertEquals(calls, 0);

  const expiredFixture = serviceFixture({
    key,
    fetch: fetched,
    now: (() => {
      let invocation = 0;
      return () =>
        new Date(
          invocation++ === 0 ? "2026-07-22T00:00:00Z" : "2026-07-22T00:11:00Z",
        );
    })(),
  });
  const expiredStart = await expiredFixture.service.start("owner-a");
  if (!expiredStart.ok) throw new Error(expiredStart.error.kind);
  const expired = await expiredFixture.service.complete({
    ownerId: "owner-a",
    state: new URL(expiredStart.value.authorizationUrl).searchParams.get(
      "state",
    ),
    code: "code",
  });
  assertEquals(expired.ok, false);
  if (!expired.ok) assertEquals(expired.error.kind, "OAuthTransactionExpired");
  assertEquals(calls, 0);

  const nonceFixture = serviceFixture({
    key,
    fetch: fetched,
    nonce: () => "wrong-nonce",
  });
  const nonceStart = await nonceFixture.service.start("owner-a");
  if (!nonceStart.ok) throw new Error(nonceStart.error.kind);
  const mismatch = await nonceFixture.service.complete({
    ownerId: "owner-a",
    state: new URL(nonceStart.value.authorizationUrl).searchParams.get("state"),
    code: "code",
  });
  assertEquals(mismatch.ok, false);
  if (!mismatch.ok) {
    assertEquals(mismatch.error.kind, "OAuthIdTokenNonceMismatch");
  }
  assertEquals(nonceFixture.connections.records.size, 0);
});

Deno.test("OAuth access token refresh validates provider response and AES-GCM AAD binds owner and key version", async () => {
  const key = await encryptionKey();
  const connections = new ConnectionStoreFixture();
  const encrypted = await encryptRefreshToken({
    ownerId: "owner-a",
    refreshToken: "refresh-token",
    keyVersion: "key-2026-07",
    key,
  }, {
    subtle: crypto.subtle,
    randomBytes: (length) => new Uint8Array(length).fill(9),
  });
  if (!encrypted.ok) throw new Error(encrypted.error.kind);
  await connections.write(Object.freeze({
    status: "connected",
    ownerId: "owner-a",
    providerSubject: "sub",
    accountEmail: "owner@example.test",
    grantedScopes: scopes,
    refreshToken: encrypted.value,
    connectedAt: "2026-07-21T00:00:00Z",
    updatedAt: "2026-07-21T00:00:00Z",
  }));
  /** @type {URLSearchParams | null} */ let submitted = null;
  const { service } = serviceFixture({
    key,
    connections,
    fetch: /** @type {typeof fetch} */ (async (_input, init) => {
      submitted = /** @type {URLSearchParams} */ (init?.body);
      return json(
        JSON.stringify({
          access_token: "fresh-access",
          expires_in: 1800,
          token_type: "Bearer",
          scope: scopes.join(" "),
        }),
      );
    }),
  });
  const token = await service.getAccessToken("owner-a");
  assertEquals(token.ok, true);
  if (token.ok) {
    assertEquals(token.value.accessToken, "fresh-access");
    assertEquals(token.value.expiresAt, "2026-07-22T00:30:00.000Z");
  }
  assertEquals(parameters(submitted).get("refresh_token"), "refresh-token");
  const wrongOwner = await decryptRefreshToken({
    ownerId: "owner-b",
    envelope: encrypted.value,
    key,
  }, { subtle: crypto.subtle });
  assertEquals(wrongOwner.ok, false);
  if (!wrongOwner.ok) {
    assertEquals(wrongOwner.error.kind, "OAuthRefreshTokenDecryptionFailed");
  }
});

Deno.test("OAuth revoke preserves an active connection on provider failure and removes its token after success", async () => {
  const key = await encryptionKey();
  const connections = new ConnectionStoreFixture();
  const envelope = await encryptRefreshToken({
    ownerId: "owner-a",
    refreshToken: "refresh",
    keyVersion: "key-2026-07",
    key,
  }, {
    subtle: crypto.subtle,
    randomBytes: (length) => new Uint8Array(length).fill(4),
  });
  if (!envelope.ok) throw new Error(envelope.error.kind);
  const active = Object.freeze({
    status: "connected",
    ownerId: "owner-a",
    providerSubject: "sub",
    accountEmail: "owner@example.test",
    grantedScopes: scopes,
    refreshToken: envelope.value,
    connectedAt: "2026-07-21T00:00:00Z",
    updatedAt: "2026-07-21T00:00:00Z",
  });
  await connections.write(active);
  let providerStatus = 503;
  const { service } = serviceFixture({
    key,
    connections,
    fetch: /** @type {typeof fetch} */ (async () =>
      new Response(null, { status: providerStatus })),
  });
  const failed = await service.revoke("owner-a");
  assertEquals(failed.ok, false);
  if (!failed.ok) {
    assertEquals(failed.error.kind, "OAuthProviderRevocationFailed");
  }
  assertEquals(connections.records.get("owner-a")?.status, "connected");
  providerStatus = 200;
  const revoked = await service.revoke("owner-a");
  assertEquals(revoked.ok, true);
  assertEquals(connections.records.get("owner-a")?.status, "revoked");
  assert(
    !JSON.stringify(connections.records.get("owner-a")).includes("ciphertext"),
    "Revoked state retained encrypted token material.",
  );
  const token = await service.getAccessToken("owner-a");
  assertEquals(token.ok, false);
  if (!token.ok) assertEquals(token.error.kind, "OAuthConnectionRevoked");
});

/** @param {Uint8Array} bytes */
function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}

/** @param {unknown} value */
function parameters(value) {
  if (!(value instanceof URLSearchParams)) {
    throw new Error("Token parameters were not submitted.");
  }
  return value;
}
