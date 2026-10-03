import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createECDH, randomBytes } from "node:crypto";
import test from "node:test";
import { createSourceNotificationService } from "../worker/reminders/source-updates.js";

const device = "123e4567-e89b-42d3-a456-426614174000";
const secondDevice = "123e4567-e89b-42d3-a456-426614174001";
const at = "2026-10-02T12:00:00.000Z";
const event = {
  ownerId: "owner",
  runId: "run",
  revision: 2,
  kind: "source-ready",
  occurredAt: at,
};
const key = createECDH("prime256v1");
key.generateKeys();

async function fixture(sender = async () => true) {
  const db = new DatabaseSync(":memory:");
  for (
    const name of [
      "0016_daily_reminders.sql",
      "0017_source_notification_deliveries.sql",
    ]
  ) {
    db.exec(
      await readFile(
        new URL(`../worker/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  }
  const enroll = (id = device, owner = "owner") =>
    db.prepare(
      "INSERT INTO daily_reminders(owner_id,device_id,enabled,reminder_time,time_zone,endpoint,p256dh,auth,updated_at,skipped_date,last_reminded_date) VALUES (?,?,1,'20:00','UTC',?,?,?,?,'2026-10-02','2026-10-02')",
    ).run(
      owner,
      id,
      "https://fcm.googleapis.com/fcm/send/synthetic",
      key.getPublicKey().toString("base64url"),
      randomBytes(16).toString("base64url"),
      at,
    );
  enroll();
  const logs = [], sent = [];
  const database = {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        bind(...args) {
          return {
            first: async () => stmt.get(...args) ?? null,
            all: async () => ({ success: true, results: stmt.all(...args) }),
            run: async () => ({
              success: true,
              meta: { changes: Number(stmt.run(...args).changes) },
            }),
          };
        },
      };
    },
  };
  const service = createSourceNotificationService({
    database,
    now: () => new Date(at),
    allowedOrigins: ["https://fcm.googleapis.com"],
    logger: (e) => logs.push(e),
    sender: async (subscription, payload) => {
      sent.push(payload);
      return sender(subscription, payload);
    },
  });
  return { db, enroll, logs, sent, service, database };
}
const current = async () => ({ ok: true, value: true });

test("source events share opt-in, ignore daily suppression, isolate owners and deduplicate concurrent sends", async () => {
  const f = await fixture();
  try {
    f.enroll(secondDevice);
    f.enroll("123e4567-e89b-42d3-a456-426614174002", "another-owner");
    const outcomes = await Promise.all([
      f.service.notify(event, current),
      f.service.notify(event, current),
    ]);
    assert.ok(outcomes.every((r) => r.ok));
    assert.equal(f.sent.length, 2);
    assert.deepEqual(Object.keys(f.sent[0]).sort(), [
      "expiresAt",
      "id",
      "type",
    ]);
    assert.equal(f.sent[0].type, "source-ready");
    assert.equal(
      f.db.prepare(
        "SELECT COUNT(*) AS n FROM source_notification_deliveries WHERE status='sent'",
      ).get().n,
      2,
    );
    f.db.exec("UPDATE daily_reminders SET enabled=0 WHERE owner_id='owner'");
    assert.equal(
      (await f.service.notify({
        ...event,
        revision: 3,
        kind: "source-attention",
      }, current)).ok,
      true,
    );
    assert.equal(f.sent.length, 2);
  } finally {
    f.db.close();
  }
});

test("source updates reject invalid commands, stale events and failed authoritative reads before sending", async () => {
  const f = await fixture();
  try {
    for (
      const value of [
        null,
        { ...event, kind: "scraping-finished" },
        { ...event, revision: 0 },
        { ...event, occurredAt: "bad" },
        { ...event, title: "private" },
      ]
    ) {
      assert.deepEqual(await f.service.notify(value, current), {
        ok: false,
        error: { kind: "ReminderCommandInvalid" },
      });
    }
    assert.deepEqual(
      await f.service.notify(
        event,
        async () => ({ ok: false, error: { kind: "ReminderReadUnavailable" } }),
      ),
      { ok: false, error: { kind: "ReminderReadUnavailable" } },
    );
    assert.equal(
      (await f.service.notify(event, async () => ({ ok: true, value: false })))
        .ok,
      true,
    );
    assert.equal(
      (await f.service.notify({
        ...event,
        occurredAt: "2026-10-02T10:00:00.000Z",
      }, current)).ok,
      true,
    );
    assert.deepEqual(
      await f.service.notify({
        ...event,
        occurredAt: "2026-10-03T10:00:00.000Z",
      }, current),
      { ok: false, error: { kind: "ReminderCommandInvalid" } },
    );
    assert.equal(f.sent.length, 0);
  } finally {
    f.db.close();
  }
});

test("uncertain delivery is recorded once, other devices continue, and expired subscriptions disable", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    if (calls === 1) throw new Error("private endpoint must not enter logs");
    return false;
  });
  try {
    f.enroll(secondDevice);
    assert.deepEqual(await f.service.notify(event, current), {
      ok: false,
      error: { kind: "ReminderDeliveryFailed" },
    });
    assert.equal((await f.service.notify(event, current)).ok, true);
    assert.equal(calls, 2);
    assert.deepEqual(
      f.db.prepare(
        "SELECT status FROM source_notification_deliveries ORDER BY device_id",
      ).all().map((r) => r.status),
      ["delivery-failed", "disabled-expired"],
    );
    assert.equal(
      f.db.prepare("SELECT enabled FROM daily_reminders WHERE device_id=?").get(
        secondDevice,
      ).enabled,
      0,
    );
    assert.ok(!JSON.stringify(f.logs).includes("private endpoint"));
  } finally {
    f.db.close();
  }
});

test("claim errors and unavailable configuration fail without sending or changing learner data", async () => {
  const f = await fixture();
  try {
    const dependencies = {
      database: f.database,
      now: () => new Date(at),
      allowedOrigins: ["https://fcm.googleapis.com"],
      logger: () => {},
      sender: null,
    };
    assert.deepEqual(
      await createSourceNotificationService(dependencies).notify(
        event,
        current,
      ),
      { ok: false, error: { kind: "ReminderConfigurationMissing" } },
    );
    f.db.exec("DROP TABLE source_notification_deliveries");
    assert.deepEqual(await f.service.notify(event, current), {
      ok: false,
      error: { kind: "ReminderWriteUnavailable" },
    });
    assert.equal(f.sent.length, 0);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM daily_reminders").get().n,
      1,
    );
  } finally {
    f.db.close();
  }
});
