import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { D1R2CapacityLedger } from "../worker/r2-capacity-d1.js";

async function fixture(
  { list, storedBytesLimit = 1000, classAMonthlyLimit = 100 } = {},
) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      new URL("../worker/migrations/0004_r2_capacity.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(
    "INSERT INTO source_r2_account_capacity VALUES ('scope',5,'2026-10-16T00:00:00.000Z','2026-10-16T00:00:00.000Z'); INSERT INTO source_r2_monthly_capacity VALUES ('scope','2026-10',7,11,'2026-10-16T00:00:00.000Z')",
  );
  const port = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async run() {
              const r = db.prepare(sql).run(...values);
              return { success: true, meta: { changes: Number(r.changes) } };
            },
            async first() {
              return db.prepare(sql).get(...values) ?? null;
            },
          };
        },
      };
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  let id = 0;
  const dependencies = {
    database: port,
    policy: {
      accountScope: "scope",
      storedBytesLimit,
      classAMonthlyLimit,
      classBMonthlyLimit: 100,
      observationMaximumAgeMs: 86400000,
    },
    now: () => "2026-10-16T12:00:00.000Z",
    createId: () => String(++id),
  };
  const pending = await new D1R2CapacityLedger(dependencies).reserve({
    ownerId: "owner",
    objectKey: "source-content/pending",
    operation: "write",
    expectedStoredBytes: 10,
  });
  assert(pending.ok);
  db.exec(
    "UPDATE source_r2_account_capacity SET observed_at='2026-10-14T00:00:00.000Z'",
  );
  const calls = [];
  const ledger = new D1R2CapacityLedger({
    ...dependencies,
    bucket: {
      async list(options) {
        calls.push(options);
        return list
          ? list(options)
          : options.cursor
          ? { objects: [{ size: 50 }], truncated: false }
          : { objects: [{ size: 30 }], truncated: true, cursor: "next" };
      },
    },
  });
  return {
    db,
    ledger,
    calls,
    close: () => db.close(),
    reserve: () =>
      ledger.reserve({
        ownerId: "owner",
        objectKey: "source-content/new",
        operation: "write",
        expectedStoredBytes: 7,
      }),
  };
}

test("stale R2 observation refreshes from paged live metadata and preserves pending bytes and operation counts", async () => {
  const f = await fixture();
  try {
    const result = await f.reserve();
    assert(result.ok);
    assert.deepEqual(f.calls, [{}, { cursor: "next" }]);
    const capacity = f.db.prepare("SELECT * FROM source_r2_account_capacity")
      .get();
    assert.equal(capacity.stored_bytes, 97);
    assert.equal(capacity.observed_at, "2026-10-16T12:00:00.000Z");
    const monthly = f.db.prepare("SELECT * FROM source_r2_monthly_capacity")
      .get();
    assert.equal(monthly.class_a_operations, 11);
    assert.equal(monthly.class_b_operations, 11);
    assert.equal(
      f.db.prepare(
        "SELECT state FROM source_r2_reservations WHERE reservation_id=?",
      ).get("1").state,
      "active",
    );
  } finally {
    f.close();
  }
});

test("R2 observation cannot bypass storage or Class A caps", async () => {
  for (const options of [{ storedBytesLimit: 96 }, { classAMonthlyLimit: 8 }]) {
    const f = await fixture(options);
    try {
      const result = await f.reserve();
      assert(!result.ok);
      assert.equal(
        result.error.kind,
        options.storedBytesLimit
          ? "R2StorageCapacityExceeded"
          : "R2ClassAOperationsExceeded",
      );
      if (options.classAMonthlyLimit) assert.equal(f.calls.length, 0);
      assert.equal(
        f.db.prepare("SELECT COUNT(*) AS n FROM source_r2_reservations").get()
          .n,
        1,
      );
    } finally {
      f.close();
    }
  }
});

test("failed or invalid R2 metadata keeps the observation stale and retains charged list attempts", async () => {
  for (
    const list of [
      () => {
        throw new Error("provider failure");
      },
      () => ({ objects: [{ size: -1 }], truncated: false }),
      () => ({ objects: [], truncated: true }),
    ]
  ) {
    const f = await fixture({ list });
    try {
      const result = await f.reserve();
      assert(!result.ok);
      assert.equal(
        f.db.prepare("SELECT observed_at FROM source_r2_account_capacity").get()
          .observed_at,
        "2026-10-14T00:00:00.000Z",
      );
      assert.equal(
        f.db.prepare(
          "SELECT class_a_operations FROM source_r2_monthly_capacity",
        ).get().class_a_operations,
        9,
      );
    } finally {
      f.close();
    }
  }
});

test("R2 observation preserves uncertain reservations and a larger prior storage estimate", async () => {
  const f = await fixture();
  try {
    f.db.exec(
      "UPDATE source_r2_reservations SET state='uncertain',outcome='uncertain',measured_stored_bytes=0,closed_at='2026-10-16T01:00:00.000Z' WHERE reservation_id='1'; UPDATE source_r2_account_capacity SET stored_bytes=150",
    );
    assert((await f.reserve()).ok);
    assert.equal(
      f.db.prepare("SELECT stored_bytes FROM source_r2_account_capacity").get()
        .stored_bytes,
      157,
    );
    assert.equal(
      f.db.prepare(
        "SELECT state FROM source_r2_reservations WHERE reservation_id=?",
      ).get("1").state,
      "uncertain",
    );
  } finally {
    f.close();
  }
});
