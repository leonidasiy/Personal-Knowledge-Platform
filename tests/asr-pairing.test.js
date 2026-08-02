// @ts-check

import { createPairingClient } from "../companion/pairing.js";
import {
  AsrJobCoordinator,
  createAsrControlPlane,
  MemoryAsrJobRepository,
} from "../worker/asr-job-coordinator.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
}
/** @param {boolean} condition @param {string} message */
function assert(condition, message) { if (!condition) throw new Error(message); }
/** @param {MemoryAsrJobRepository} repository */
function assertJobAbsent(repository) {
  const found = repository.job("owner-a", "job-1");
  assert(found.ok, "Repository read should succeed.");
  if (found.ok) assertEquals(found.value, null);
}

const secret = new Uint8Array(32).fill(7);
const otherSecret = new Uint8Array(32).fill(8);
const model = Object.freeze({ id: "whisper-local", version: "1.0.0" });
const result = Object.freeze({
  transcript: "A rights-permitted local transcript.",
  excerpt: null,
  contentDigest: "a".repeat(64),
});
const command = Object.freeze({
  jobId: "job-1",
  ownerId: "owner-a",
  source: Object.freeze({
    provenance: "rss-enclosure",
    provenanceId: "feed-item-1",
    feedUrl: "https://publisher.example/feed.xml",
    canonicalItemUrl: "https://publisher.example/episodes/1",
    enclosureUrl: "https://media.publisher.example/episodes/1.mp3",
  }),
  rights: Object.freeze({
    evidenceId: "rights-1",
    transcriptionPermitted: true,
    derivedTranscriptPermitted: true,
    excerptPermitted: false,
  }),
  media: Object.freeze({
    declaredBytes: 2_000,
    declaredDurationSeconds: 120,
    declaredMediaType: "audio/mpeg",
  }),
  timeoutMs: 20_000,
});

/** @param {Uint8Array} bytes */
function digestValue(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("").padEnd(64, "0").slice(0, 64);
}

/**
 * @param {{ readonly repository?: MemoryAsrJobRepository, readonly now?: { value: number }, readonly rights?: boolean }} [options]
 */
function harness(options = {}) {
  const repository = options.repository ?? new MemoryAsrJobRepository();
  const now = options.now ?? { value: 1_000 };
  let rightsReads = 0;
  const coordinator = new AsrJobCoordinator(
    {
      leaseMs: 500,
      secretBytes: 32,
      maximumBytes: 5_000,
      maximumDurationSeconds: 300,
      maximumTimeoutMs: 60_000,
      model,
    },
    {
      now: () => now.value,
      digest: (bytes) => Promise.resolve({ ok: true, value: digestValue(bytes) }),
      randomBytes: (length) => new Uint8Array(length).fill(9),
      equalVerifier: (left, right) => left === right,
      isYouTubeUrl: (url) => url.hostname === "youtube.example",
      rights: {
        find: (ownerId, evidenceId) => {
          rightsReads += 1;
          return {
            ok: true,
            value: options.rights === false ? null : Object.freeze({
              ownerId,
              evidenceId,
              transcriptionPermitted: true,
              derivedTranscriptPermitted: true,
              excerptPermitted: false,
            }),
          };
        },
      },
      repository,
    },
  );
  return { coordinator, repository, now, rightsReads: () => rightsReads };
}

/** @param {AsrJobCoordinator} coordinator */
async function pair(coordinator) {
  const paired = await coordinator.pair({ ownerId: "owner-a", pairingId: "pair-1", secret });
  assertEquals(paired.ok, true);
}

/** @param {string} [companionId] @param {Uint8Array} [pairingSecret] */
function companionAuth(companionId = "local-a", pairingSecret = secret) {
  return { pairingId: "pair-1", companionId, secret: pairingSecret, modelId: model.id, modelVersion: model.version };
}
/** @param {Uint8Array} bytes */
function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
/** @param {string} path @param {unknown} body @param {HeadersInit} [headers] */
function request(path, body, headers = {}) {
  return new Request(`https://worker.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

Deno.test("pairing persists a verifier only and authentication failure has no job side effect", async () => {
  const test = harness();
  await pair(test.coordinator);
  const stored = test.repository.pairing("pair-1");
  assert(stored.ok && stored.value !== null, "Pairing verifier should be stored.");
  if (stored.ok && stored.value) {
    assertEquals("secret" in stored.value, false);
    assertEquals(stored.value.verifier, digestValue(secret));
    assertEquals(stored.value.lastSeenAt, null);
  }
  assertEquals(test.coordinator.create(command).ok, true);
  const rejected = await test.coordinator.pull(companionAuth("local-a", otherSecret));
  assertEquals(rejected.ok, false);
  if (!rejected.ok) assertEquals(rejected.error.kind, "LocalWorkerAuthenticationFailed");
  const untouched = test.repository.job("owner-a", "job-1");
  assert(untouched.ok && untouched.value !== null, "Job should remain available.");
  if (untouched.ok && untouched.value) assertEquals(untouched.value.state, "waiting_for_local_worker");
  const pairing = test.repository.pairing("pair-1");
  if (pairing.ok && pairing.value) assertEquals(pairing.value.lastSeenAt, null);
});

Deno.test("job creation requires persisted rights, rejects YouTube and media bodies before every write", () => {
  const missing = harness({ rights: false });
  const missingResult = missing.coordinator.create(command);
  assertEquals(missingResult.ok, false);
  if (!missingResult.ok) assertEquals(missingResult.error.kind, "PodcastTranscriptionPermissionMissing");
  assertJobAbsent(missing.repository);

  const youtube = harness();
  const blocked = youtube.coordinator.create({ ...command, source: { ...command.source, provenance: "YouTube captions" } });
  assertEquals(blocked.ok, false);
  if (!blocked.ok) assertEquals(blocked.error.kind, "AsrJobSourceForbidden");
  assertEquals(youtube.rightsReads(), 0);
  assertJobAbsent(youtube.repository);

  const body = harness();
  const bodyResult = body.coordinator.create({ ...command, enclosureBody: new Uint8Array([1, 2, 3]) });
  assertEquals(bodyResult.ok, false);
  if (!bodyResult.ok) assertEquals(bodyResult.error.kind, "AsrJobCommandInvalid");
  assertEquals(body.rightsReads(), 0);
  assertJobAbsent(body.repository);

  const bounded = harness();
  const limit = bounded.coordinator.create({ ...command, media: { ...command.media, declaredBytes: 5_001 } });
  assertEquals(limit.ok, false);
  if (!limit.ok) assertEquals(limit.error.kind, "PodcastEnclosureLimitExceeded");
  assertJobAbsent(bounded.repository);
});

Deno.test("bounded pull leases once, then expired lease recovers through a restarted coordinator", async () => {
  const first = harness();
  await pair(first.coordinator);
  assertEquals(first.coordinator.create(command).ok, true);
  const wrongModel = await first.coordinator.pull({
    ...companionAuth(),
    modelVersion: "different",
  });
  assertEquals(wrongModel.ok, false);
  if (!wrongModel.ok) assertEquals(wrongModel.error.kind, "LocalWorkerModelMismatch");
  const beforeLease = first.repository.job("owner-a", "job-1");
  if (beforeLease.ok && beforeLease.value) assertEquals(beforeLease.value.state, "waiting_for_local_worker");
  const leased = await first.coordinator.pull(companionAuth());
  assert(leased.ok && leased.value !== null, "First pull should lease the job.");
  if (leased.ok && leased.value) {
    assertEquals(leased.value.command.model.id, model.id);
    assertEquals(leased.value.command.model.version, model.version);
  }
  const none = await first.coordinator.pull(companionAuth("local-b"));
  assert(none.ok && none.value === null, "An active lease must have one consumer.");

  first.now.value = 1_501;
  const restarted = harness({ repository: first.repository, now: first.now });
  const retried = await restarted.coordinator.pull(companionAuth("local-b"));
  assert(retried.ok && retried.value !== null, "Expired lease should be recovered after restart.");
  if (leased.ok && leased.value && retried.ok && retried.value) {
    assertEquals(retried.value.command.jobId, "job-1");
    assertEquals(retried.value.leaseToken, leased.value.leaseToken);
    assertEquals(retried.value.leaseExpiresAt, 2_001);
  }
  const stored = first.repository.job("owner-a", "job-1");
  if (stored.ok && stored.value) assertEquals(stored.value.companionId, "local-b");
});

Deno.test("result submission enforces owner lease and permitted derivative before idempotent completion", async () => {
  const test = harness();
  await pair(test.coordinator);
  test.coordinator.create(command);
  const lease = await test.coordinator.pull(companionAuth());
  assert(lease.ok && lease.value !== null, "Expected a lease.");
  if (!lease.ok || !lease.value) return;

  const wrongConsumer = await test.coordinator.submit({
    ...companionAuth("local-b"),
    jobId: "job-1", leaseToken: lease.value.leaseToken, result,
  });
  assertEquals(wrongConsumer.ok, false);
  if (!wrongConsumer.ok) assertEquals(wrongConsumer.error.kind, "AsrJobLeaseConflict");
  const stillLeased = test.repository.job("owner-a", "job-1");
  if (stillLeased.ok && stillLeased.value) assertEquals(stillLeased.value.state, "leased");

  const forbiddenExcerpt = await test.coordinator.submit({
    ...companionAuth(),
    jobId: "job-1", leaseToken: lease.value.leaseToken,
    result: { ...result, excerpt: "Not permitted." },
  });
  assertEquals(forbiddenExcerpt.ok, false);
  if (!forbiddenExcerpt.ok) assertEquals(forbiddenExcerpt.error.kind, "DerivedCardRightsNotPermitted");
  const afterExcerpt = test.repository.job("owner-a", "job-1");
  if (afterExcerpt.ok && afterExcerpt.value) assertEquals(afterExcerpt.value.state, "leased");

  const completed = await test.coordinator.submit({
    ...companionAuth(),
    jobId: "job-1", leaseToken: lease.value.leaseToken, result,
  });
  assertEquals(completed.ok, true);
  const repeated = await test.coordinator.submit({
    ...companionAuth(),
    jobId: "job-1", leaseToken: lease.value.leaseToken, result,
  });
  assertEquals(repeated.ok, true);
  const conflicting = await test.coordinator.submit({
    ...companionAuth(),
    jobId: "job-1", leaseToken: lease.value.leaseToken,
    result: { ...result, contentDigest: "b".repeat(64) },
  });
  assertEquals(conflicting.ok, false);
  if (!conflicting.ok) assertEquals(conflicting.error.kind, "AsrJobLeaseConflict");
});

Deno.test("offline companion preserves waiting state and pairing client maps transport unavailability", async () => {
  const test = harness();
  assertEquals(test.coordinator.create(command).ok, true);
  const status = test.coordinator.status("owner-a", "job-1");
  assertEquals(status.ok, false);
  if (!status.ok) {
    assertEquals(status.error.kind, "LocalWorkerUnavailable");
    if (status.error.kind === "LocalWorkerUnavailable") assertEquals(status.error.state, "waiting_for_local_worker");
  }
  const stored = test.repository.job("owner-a", "job-1");
  if (stored.ok && stored.value) assertEquals(stored.value.state, "waiting_for_local_worker");

  const client = createPairingClient(
    { pairingId: "pair-1", companionId: "local-a", secret },
    model,
    {
      pull: () => Promise.reject(new Error("offline")),
      submit: () => Promise.reject(new Error("offline")),
    },
  );
  assertEquals(client.ok, true);
  if (client.ok) {
    assertEquals("secret" in client.value, false);
    const offline = await client.value.pull();
    assertEquals(offline.ok, false);
    if (!offline.ok) assertEquals(offline.error.kind, "LocalWorkerUnavailable");
  }
});

Deno.test("pairing client and control plane interoperate with one pinned model contract", async () => {
  const test = harness();
  const plane = createAsrControlPlane(
    { maximumBodyBytes: 8_192 },
    {
      authenticateAccess: () => Promise.resolve({ ok: true, value: { ownerId: "owner-a" } }),
      coordinator: test.coordinator,
    },
  );
  assertEquals((await plane.fetch(request("/api/asr/pair", {
    pairingId: "pair-1",
    secret: base64Url(secret),
  }))).status, 201);
  assertEquals((await plane.fetch(request("/api/asr/jobs", command))).status, 202);

  /**
   * @param {string} path
   * @param {Record<string, unknown>} body
   * @returns {Promise<{ readonly ok: true, readonly value: unknown } | { readonly ok: false, readonly error: { readonly kind: string } }>}
   */
  async function invoke(path, body) {
    const response = await plane.fetch(request(path, { ...body, secret: base64Url(/** @type {Uint8Array} */ (body.secret)) }));
    const document = /** @type {Record<string, unknown>} */ (await response.json());
    return response.ok
      ? /** @type {const} */ ({ ok: true, value: document })
      : /** @type {const} */ ({ ok: false, error: { kind: typeof document.code === "string" ? document.code : "ControlPlaneRejected" } });
  }
  const client = createPairingClient(
    { pairingId: "pair-1", companionId: "local-a", secret },
    model,
    {
      pull: (body) => invoke("/api/asr/companion/pull", body),
      submit: (body) => invoke("/api/asr/companion/submit", body),
    },
  );
  assertEquals(client.ok, true);
  if (!client.ok) return;
  const pulled = await client.value.pull();
  assertEquals(pulled.ok, true);
  if (!pulled.ok || typeof pulled.value !== "object" || pulled.value === null) return;
  const job = /** @type {Record<string, unknown>} */ (pulled.value).job;
  assert(typeof job === "object" && job !== null, "Control plane should return a lease.");
  const lease = /** @type {Record<string, unknown>} */ (job);
  assertEquals(typeof lease.leaseToken, "string");
  const leasedCommand = /** @type {Record<string, unknown>} */ (lease.command);
  const leasedModel = /** @type {Record<string, unknown>} */ (leasedCommand.model);
  assertEquals(leasedModel.id, model.id);
  assertEquals(leasedModel.version, model.version);
  const submitted = await client.value.submit("job-1", /** @type {string} */ (lease.leaseToken), result);
  assertEquals(submitted.ok, true);
  const stored = test.repository.job("owner-a", "job-1");
  assert(stored.ok && stored.value?.state === "completed", "End-to-end submission should complete the lease.");
});

Deno.test("control plane authenticates Access before app coordinator calls and rejects route, method, and body bounds", async () => {
  let coordinatorCalls = 0;
  const coordinator = /** @type {Pick<AsrJobCoordinator, "pair" | "create" | "status" | "pull" | "submit">} */ ({
    pair: () => { coordinatorCalls += 1; return Promise.resolve({ ok: true, value: { pairingId: "pair-1" } }); },
    create: () => { coordinatorCalls += 1; return { ok: true, value: { jobId: "job-1", state: "waiting_for_local_worker" } }; },
    status: () => { coordinatorCalls += 1; return { ok: false, error: { kind: "AsrJobUnknown" } }; },
    pull: () => { coordinatorCalls += 1; return Promise.resolve({ ok: true, value: null }); },
    submit: () => { coordinatorCalls += 1; return Promise.resolve({ ok: true, value: { jobId: "job-1", state: "completed" } }); },
  });
  const denied = createAsrControlPlane(
    { maximumBodyBytes: 512 },
    {
      authenticateAccess: () => Promise.resolve({ ok: false, error: { kind: "DiscoveryAccessTokenMissing" } }),
      coordinator,
    },
  );
  const rejected = await denied.fetch(request("/api/asr/pair", { pairingId: "pair-1", secret: base64Url(secret) }));
  assertEquals(rejected.status, 401);
  assertEquals(coordinatorCalls, 0);

  const allowed = createAsrControlPlane(
    { maximumBodyBytes: 64 },
    {
      authenticateAccess: () => Promise.resolve({ ok: true, value: { ownerId: "owner-a" } }),
      coordinator,
    },
  );
  const oversized = await allowed.fetch(request("/api/asr/jobs", {}, { "content-length": "65" }));
  assertEquals(oversized.status, 413);
  assertEquals(coordinatorCalls, 0);
  const unknown = await allowed.fetch(request("/api/asr/unknown", {}));
  assertEquals(unknown.status, 404);
  const method = await allowed.fetch(new Request("https://worker.example/api/asr/jobs", { method: "GET" }));
  assertEquals(method.status, 405);
  assertEquals(coordinatorCalls, 0);
});

Deno.test("control plane enforces authenticated owner and pairing auth without leaking secrets", async () => {
  const test = harness();
  const plane = createAsrControlPlane(
    { maximumBodyBytes: 8_192 },
    {
      authenticateAccess: () => Promise.resolve({ ok: true, value: { ownerId: "owner-a" } }),
      coordinator: test.coordinator,
    },
  );
  const paired = await plane.fetch(request("/api/asr/pair", { pairingId: "pair-1", secret: base64Url(secret) }));
  assertEquals(paired.status, 201);
  const pairedText = await paired.text();
  assert(pairedText.includes("pair-1"), "Pair response should contain its public ID.");
  assertEquals(pairedText.includes("secret"), false);
  assertEquals(pairedText.includes("verifier"), false);

  const maliciousPair = await plane.fetch(request("/api/asr/pair", {
    pairingId: "pair-2",
    ownerId: "owner-b",
    secret: base64Url(secret),
  }));
  assertEquals(maliciousPair.status, 400);
  const pairTwo = test.repository.pairing("pair-2");
  assert(pairTwo.ok, "Pairing repository read should succeed.");
  if (pairTwo.ok) assertEquals(pairTwo.value, null);

  const wrongOwner = await plane.fetch(request("/api/asr/jobs", { ...command, ownerId: "owner-b" }));
  assertEquals(wrongOwner.status, 403);
  assertJobAbsent(test.repository);
  const created = await plane.fetch(request("/api/asr/jobs", command));
  assertEquals(created.status, 202);

  const badAuth = await plane.fetch(request("/api/asr/companion/pull", {
    ...companionAuth("local-a", otherSecret),
    secret: base64Url(otherSecret),
  }));
  assertEquals(badAuth.status, 401);
  const waiting = test.repository.job("owner-a", "job-1");
  if (waiting.ok && waiting.value) assertEquals(waiting.value.state, "waiting_for_local_worker");

  const pulled = await plane.fetch(request("/api/asr/companion/pull", {
    ...companionAuth(),
    secret: base64Url(secret),
  }));
  assertEquals(pulled.status, 200);
  const pulledText = await pulled.text();
  assert(pulledText.includes(model.id), "Pinned model must be in the leased command.");
  assert(pulledText.includes(command.source.enclosureUrl), "Authoritative enclosure provenance must be retained.");
  assertEquals(pulledText.includes("enclosureBody"), false);
  assertEquals(pulledText.includes("secret"), false);
  assertEquals(pulledText.includes("verifier"), false);
});
