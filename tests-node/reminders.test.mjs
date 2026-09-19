import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  createReminderService,
  reminderLocalClock,
} from "../worker/reminders/service.js";

const migration = await readFile(
  new URL("../worker/migrations/0016_daily_reminders.sql", import.meta.url),
  "utf8",
);
const device = "123e4567-e89b-42d3-a456-426614174000";

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replaceAll("=", "");
}

const keyPair = await crypto.subtle.generateKey(
  { name: "ECDH", namedCurve: "P-256" },
  true,
  ["deriveBits"],
);
const publicKey = base64url(
  await crypto.subtle.exportKey("raw", keyPair.publicKey),
);
const auth = base64url(crypto.getRandomValues(new Uint8Array(16)));
const subscription = Object.freeze({
  endpoint: "https://fcm.googleapis.com/fcm/send/a-token",
  keys: Object.freeze({ p256dh: publicKey, auth }),
});
const save = (
  deviceId = device,
  enabled = true,
  time = "20:00",
  timeZone = "UTC",
) => ({
  action: "save",
  deviceId,
  enabled,
  time,
  timeZone,
  subscription: enabled ? subscription : null,
});

function d1(sqlite, hooks = {}) {
  return {
    prepare(query) {
      if (hooks.prepare) hooks.prepare(query);
      const statement = sqlite.prepare(query);
      return {
        all: async () => ({
          success: hooks.allSuccess ?? true,
          results: statement.all(),
        }),
        bind(...values) {
          return {
            first: async () => statement.get(...values) ?? null,
            all: async () => ({
              success: hooks.allSuccess ?? true,
              results: statement.all(...values),
            }),
            run: async () => {
              if (hooks.run) {
                const outcome = hooks.run(query, values, statement, sqlite);
                if (outcome !== undefined) return outcome;
              }
              statement.run(...values);
              return {
                success: true,
                meta: {
                  changes: Number(
                    sqlite.prepare("SELECT changes() AS changes").get().changes,
                  ),
                },
              };
            },
          };
        },
      };
    },
  };
}

function fixture(
  { at = "2026-03-08T20:30:00.000Z", sender = async () => true, hooks = {} } =
    {},
) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    `${migration}\nCREATE TABLE learner_review_batches (owner_id TEXT, status TEXT, completed_at TEXT); CREATE TABLE learner_feed_batches (owner_id TEXT, status TEXT, completed_at TEXT); CREATE TABLE learner_knowledge_state (owner_id TEXT, knowledge_id TEXT, studied_at TEXT, due_at TEXT); CREATE TABLE extraction_knowledge_points (owner_id TEXT, knowledge_id TEXT, source_id TEXT, source_revision INTEGER); CREATE TABLE knowledge_workflow_quizzes (owner_id TEXT, knowledge_id TEXT, source_id TEXT, source_revision INTEGER, status TEXT); CREATE TABLE learning_generation_tasks (owner_id TEXT, item_id TEXT, status TEXT); CREATE TABLE library_sources (owner_id TEXT, source_id TEXT, state TEXT);`,
  );
  let now = new Date(at);
  const logs = [];
  return {
    sqlite,
    setNow: (value) => {
      now = new Date(value);
    },
    logs,
    service: createReminderService({
      database: d1(sqlite, hooks),
      publicKey,
      allowedOrigins: ["https://fcm.googleapis.com"],
      now: () => now,
      logger: (entry) => logs.push(entry),
      sender,
    }),
  };
}

async function enabled(
  f,
  owner = "owner-a",
  deviceId = device,
  time = "20:00",
  zone = "UTC",
) {
  const value = await f.service.save(owner, save(deviceId, true, time, zone));
  assert.equal(value.ok, true, JSON.stringify(value));
}

function eligibleDue(
  f,
  {
    sourceState = "active",
    quizStatus = "published",
    taskStatus = "published",
  } = {},
) {
  f.sqlite.prepare("INSERT INTO learner_knowledge_state VALUES (?,?,?,?)").run(
    "owner-a",
    "knowledge-a",
    "2026-03-08T18:00:00.000Z",
    "2026-03-08T19:00:00.000Z",
  );
  f.sqlite.prepare("INSERT INTO extraction_knowledge_points VALUES (?,?,?,?)")
    .run("owner-a", "knowledge-a", "source-a", 1);
  f.sqlite.prepare("INSERT INTO knowledge_workflow_quizzes VALUES (?,?,?,?,?)")
    .run("owner-a", "knowledge-a", "source-a", 1, quizStatus);
  f.sqlite.prepare("INSERT INTO learning_generation_tasks VALUES (?,?,?)").run(
    "owner-a",
    "knowledge-a",
    taskStatus,
  );
  f.sqlite.prepare("INSERT INTO library_sources VALUES (?,?,?)").run(
    "owner-a",
    "source-a",
    sourceState,
  );
}

test("save/load/disable/skip are owner-isolated and use real P-256 subscription bytes", async () => {
  const f = fixture();
  assert.deepEqual(await f.service.get("owner-a", device), {
    ok: true,
    value: {
      deviceId: device,
      enabled: false,
      time: "20:00",
      timeZone: null,
      skippedDate: null,
      lastStatus: null,
      publicKey,
    },
  });
  await enabled(f);
  assert.equal((await f.service.get("owner-b", device)).value.enabled, false);
  assert.equal(
    (await f.service.skip("owner-a", { action: "skip", deviceId: device }))
      .value.lastStatus,
    "skipped",
  );
  const disabled = await f.service.save("owner-a", save(device, false));
  assert.equal(disabled.value.enabled, false);
  assert.equal(
    (await f.service.skip("owner-a", { action: "skip", deviceId: device }))
      .error.kind,
    "ReminderNotEnabled",
  );
});

test("command, persisted data, and D1 failures return typed failures", async () => {
  const f = fixture();
  assert.equal(
    (await f.service.save("owner-a", { ...save(), extra: true })).error.kind,
    "ReminderCommandInvalid",
  );
  assert.equal(
    (await f.service.save("owner-a", {
      ...save(),
      subscription: { ...subscription, endpoint: "https://evil.example/x" },
    })).error.kind,
    "ReminderCommandInvalid",
  );
  f.sqlite.prepare(
    "INSERT INTO daily_reminders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "owner-a",
    device,
    1,
    "20:00",
    "Invalid/Zone",
    null,
    subscription.endpoint,
    subscription.keys.p256dh,
    subscription.keys.auth,
    null,
    null,
    null,
    1,
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(
    (await f.service.get("owner-a", device)).error.kind,
    "ReminderDataInvalid",
  );
  const broken = createReminderService({
    database: {
      prepare() {
        throw new Error("db down");
      },
    },
    publicKey,
    allowedOrigins: ["https://fcm.googleapis.com"],
    now: () => new Date(),
    logger() {},
    sender: async () => true,
  });
  assert.equal(
    (await broken.get("owner-a", device)).error.kind,
    "ReminderReadUnavailable",
  );
  const failedWrite = createReminderService({
    database: {
      prepare() {
        return {
          bind() {
            return {
              first: async () => null,
              run: async () => ({ success: false }),
            };
          },
        };
      },
    },
    publicKey,
    allowedOrigins: ["https://fcm.googleapis.com"],
    now: () => new Date(),
    logger() {},
    sender: async () => true,
  });
  assert.equal(
    (await failedWrite.save("owner-a", save())).error.kind,
    "ReminderWriteUnavailable",
  );
});

test("one local daily claim survives concurrent runs and never retries uncertain delivery", async () => {
  let sends = 0;
  const f = fixture({
    sender: async () => {
      sends++;
      throw new Error("network uncertain");
    },
  });
  await enabled(f);
  const [first, second] = await Promise.all([f.service.run(), f.service.run()]);
  assert.equal(sends, 1);
  assert.equal(
    [first, second].filter((result) =>
      !result.ok && result.error.kind === "ReminderDeliveryFailed"
    ).length,
    1,
  );
  assert.equal((await f.service.run()).value.sent, 0);
  assert.equal(sends, 1);
  assert.equal(
    (await f.service.get("owner-a", device)).value.lastStatus,
    "delivery-failed",
  );
});

test("due window, local midnight, DST gap/fold, and timezone travel use the saved zone", async () => {
  assert.deepEqual(
    reminderLocalClock(
      new Date("2026-03-08T07:30:00.000Z"),
      "America/New_York",
    ),
    { day: "2026-03-08", minute: 210 },
  );
  assert.deepEqual(
    reminderLocalClock(
      new Date("2026-11-01T05:30:00.000Z"),
      "America/New_York",
    ),
    { day: "2026-11-01", minute: 90 },
  );
  assert.deepEqual(
    reminderLocalClock(
      new Date("2026-11-01T06:30:00.000Z"),
      "America/New_York",
    ),
    { day: "2026-11-01", minute: 90 },
  );
  let sends = 0;
  const f = fixture({
    at: "2026-11-01T05:30:00.000Z",
    sender: async () => (++sends, true),
  });
  await enabled(f, "owner-a", device, "01:30", "America/New_York");
  assert.equal((await f.service.run()).value.sent, 1);
  f.setNow("2026-11-01T06:30:00.000Z");
  assert.equal((await f.service.run()).value.sent, 0);
  assert.equal(sends, 1);
  const midnight = fixture({ at: "2026-01-01T10:05:00.000Z" });
  await enabled(midnight, "owner-a", device, "00:00", "Pacific/Kiritimati");
  assert.equal((await midnight.service.run()).value.sent, 1);
  const late = fixture({ at: "2026-01-01T21:01:00.000Z" });
  await enabled(late, "owner-a", device, "20:00", "UTC");
  assert.equal((await late.service.run()).value.sent, 0);
});

test("completed review suppresses regardless of answer; feed completion suppresses only when nothing is due", async () => {
  const review = fixture();
  await enabled(review);
  review.sqlite.prepare("INSERT INTO learner_review_batches VALUES (?,?,?)")
    .run("owner-a", "completed", "2026-03-08T19:00:00.000Z");
  assert.equal((await review.service.run()).value.sent, 0);
  const studyOnly = fixture();
  await enabled(studyOnly);
  studyOnly.sqlite.prepare("INSERT INTO learner_feed_batches VALUES (?,?,?)")
    .run("owner-a", "completed", "2026-03-08T19:00:00.000Z");
  assert.equal((await studyOnly.service.run()).value.sent, 0);
  const withDue = fixture();
  await enabled(withDue);
  withDue.sqlite.prepare("INSERT INTO learner_feed_batches VALUES (?,?,?)").run(
    "owner-a",
    "completed",
    "2026-03-08T19:00:00.000Z",
  );
  eligibleDue(withDue);
  assert.equal((await withDue.service.run()).value.sent, 1);
  const future = fixture();
  await enabled(future);
  future.sqlite.prepare("INSERT INTO learner_review_batches VALUES (?,?,?)")
    .run("owner-a", "completed", "2026-03-08T21:00:00.000Z");
  assert.equal((await future.service.run()).value.sent, 1);
});

test("stale due state does not defeat a completed feed when no review candidate remains", async () => {
  for (
    const state of [
      { sourceState: "disabled" },
      { quizStatus: "pending-review" },
      { taskStatus: "hidden" },
    ]
  ) {
    const f = fixture();
    await enabled(f);
    f.sqlite.prepare("INSERT INTO learner_feed_batches VALUES (?,?,?)").run(
      "owner-a",
      "completed",
      "2026-03-08T19:00:00.000Z",
    );
    eligibleDue(f, state);
    assert.equal((await f.service.run()).value.sent, 0, JSON.stringify(state));
  }
});

test("a claim write failure happens before delivery and a concurrent disable is preserved", async () => {
  let sends = 0;
  const f = fixture({
    hooks: {
      run(query) {
        if (query.startsWith("UPDATE daily_reminders SET last_reminded_date")) {
          throw new Error("claim down");
        }
      },
    },
    sender: async () => (++sends, true),
  });
  await enabled(f);
  assert.equal((await f.service.run()).error.kind, "ReminderRunFailed");
  assert.equal(sends, 0);
  let concurrent;
  concurrent = fixture({
    sender: async () => {
      concurrent.sqlite.prepare(
        "UPDATE daily_reminders SET enabled=0,revision=revision+1 WHERE owner_id=? AND device_id=?",
      ).run("owner-a", device);
      return false;
    },
  });
  await enabled(concurrent);
  const result = await concurrent.service.test("owner-a", {
    action: "test",
    deviceId: device,
  });
  assert.equal(result.ok, true);
  assert.equal(
    (await concurrent.service.get("owner-a", device)).value.enabled,
    false,
  );
});

test("test is globally claimed for sixty seconds and expired providers disable cleanly", async () => {
  let sends = 0;
  const f = fixture({ sender: async () => (++sends, false) });
  await enabled(f);
  const first = await f.service.test("owner-a", {
    action: "test",
    deviceId: device,
  });
  assert.equal(first.ok, true);
  assert.equal(first.value.enabled, false);
  assert.equal(first.value.lastStatus, "disabled-expired");
  assert.equal(sends, 1);
  const rate = fixture({ sender: async () => (++sends, true) });
  await enabled(rate);
  assert.equal(
    (await rate.service.test("owner-a", { action: "test", deviceId: device }))
      .ok,
    true,
  );
  assert.equal(
    (await rate.service.test("owner-a", { action: "test", deviceId: device }))
      .error.kind,
    "ReminderTestRateLimited",
  );
});

test("run rejects the 1001st enabled device with a typed capacity error", async () => {
  const f = fixture();
  const insert = f.sqlite.prepare(
    "INSERT INTO daily_reminders (owner_id,device_id,enabled,reminder_time,time_zone,endpoint,p256dh,auth,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  for (let index = 0; index < 1001; index++) {
    const tail = index.toString(16).padStart(12, "0");
    insert.run(
      "owner-a",
      `123e4567-e89b-42d3-a456-${tail}`,
      1,
      "20:00",
      "UTC",
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      "2026-01-01T00:00:00.000Z",
    );
  }
  assert.equal((await f.service.run()).error.kind, "ReminderCapacityExceeded");
});
