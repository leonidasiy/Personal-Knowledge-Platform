import assert from "node:assert/strict";
import test from "node:test";
import webPush from "web-push";
import { handleReminderRequest } from "../worker/reminders/http.js";
import { createWebPushSender } from "../worker/reminders/transport.js";
import { createReminderRuntime } from "../worker/reminders/runtime.js";

const device = "123e4567-e89b-42d3-a456-426614174000";
const vapid = webPush.generateVAPIDKeys();
const raw = await crypto.subtle.exportKey(
  "raw",
  (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )).publicKey,
);
const p256dh = Buffer.from(raw).toString("base64url");
const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
  "base64url",
);
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/token",
  keys: { p256dh, auth },
};

test("HTTP parses a bounded JSON-only body and never takes owner identity from it", async () => {
  const calls = [];
  const service = {
    async get(owner, id) {
      calls.push(["get", owner, id]);
      return { ok: true, value: { id } };
    },
    async save(owner, command) {
      calls.push(["save", owner, command]);
      return { ok: true, value: {} };
    },
    async skip() {
      return { ok: true, value: {} };
    },
    async test() {
      return { ok: true, value: {} };
    },
  };
  let response = await handleReminderRequest(
    new Request(`https://app.example/api/reminders?deviceId=${device}`),
    "owner-a",
    service,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], ["get", "owner-a", device]);
  response = await handleReminderRequest(
    new Request("https://app.example/api/reminders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "save",
        deviceId: device,
        ownerId: "owner-b",
      }),
    }),
    "owner-a",
    service,
  );
  assert.equal(response.status, 400);
  response = await handleReminderRequest(
    new Request("https://app.example/api/reminders", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    }),
    "owner-a",
    service,
  );
  assert.equal(response.status, 400);
  response = await handleReminderRequest(
    new Request("https://app.example/api/reminders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(8193),
    }),
    "owner-a",
    service,
  );
  assert.equal(response.status, 413);
  response = await handleReminderRequest(
    new Request("https://app.example/api/reminders?x=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    "owner-a",
    service,
  );
  assert.equal(response.status, 400);
});

test("transport accepts only configured push origins, encrypts a fixed payload, and treats only expiry as unsubscribe", async () => {
  const requests = [];
  const sender = createWebPushSender({
    publicKey: vapid.publicKey,
    privateKey: vapid.privateKey,
    subject: "mailto:test@example.com",
    allowedOrigins: ["https://fcm.googleapis.com"],
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response(null, { status: 201 });
    },
  });
  assert.equal(
    await sender(subscription, {
      type: "daily-reminder",
      id: "device:date",
      expiresAt: "2026-01-01T00:00:00.000Z",
    }),
    true,
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, subscription.endpoint);
  assert.equal(requests[0].init.redirect, "error");
  assert.ok(
    requests[0].init.headers.Authorization ||
      requests[0].init.headers.authorization,
  );
  await assert.rejects(
    () =>
      sender({ ...subscription, endpoint: "https://evil.example/send/x" }, {
        type: "daily-reminder",
        id: "x",
        expiresAt: "2026-01-01T00:00:00.000Z",
      }),
    /ReminderTransportInputInvalid/,
  );
  const expired = createWebPushSender({
    publicKey: vapid.publicKey,
    privateKey: vapid.privateKey,
    subject: "mailto:test@example.com",
    allowedOrigins: ["https://fcm.googleapis.com"],
    fetch: async () => new Response(null, { status: 410 }),
  });
  assert.equal(
    await expired(subscription, {
      type: "daily-reminder",
      id: "x",
      expiresAt: "2026-01-01T00:00:00.000Z",
    }),
    false,
  );
  const rejected = createWebPushSender({
    publicKey: vapid.publicKey,
    privateKey: vapid.privateKey,
    subject: "mailto:test@example.com",
    allowedOrigins: ["https://fcm.googleapis.com"],
    fetch: async () => new Response(null, { status: 500 }),
  });
  await assert.rejects(
    () =>
      rejected(subscription, {
        type: "daily-reminder",
        id: "x",
        expiresAt: "2026-01-01T00:00:00.000Z",
      }),
    /ReminderPushRejected:500/,
  );
});

test("runtime fails closed for absent, partial, or invalid push configuration", async () => {
  const database = {
    prepare() {
      throw new Error("must not read database when unavailable");
    },
  };
  const logs = [];
  for (
    const [environment, kind] of [[{}, "ReminderCommandInvalid"], [{
      VAPID_PUBLIC_KEY: vapid.publicKey,
    }, "ReminderConfigurationMissing"], [{
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: "mailto:test@example.com",
      REMINDER_PUSH_ORIGINS: "not-json",
    }, "ReminderConfigurationMissing"]]
  ) {
    const runtime = createReminderRuntime({
      environment,
      database,
      now: () => new Date(),
      fetch,
      logger: (entry) => logs.push(entry),
    });
    const result = await runtime.save("owner-a", {
      action: "save",
      deviceId: device,
      enabled: true,
      time: "20:00",
      timeZone: "UTC",
      subscription,
    });
    assert.deepEqual(result, { ok: false, error: { kind } });
  }
  assert.equal(
    logs.filter((entry) => entry.event === "reminder-configuration-failure")
      .length,
    2,
  );
});
