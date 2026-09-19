// @ts-check

/** @typedef {'ReminderDeviceInvalid'|'ReminderCommandInvalid'|'ReminderSubscriptionRequired'|'ReminderConfigurationMissing'|'ReminderClockInvalid'|'ReminderDataInvalid'|'ReminderReadUnavailable'|'ReminderWriteUnavailable'|'ReminderConflict'|'ReminderNotEnabled'|'ReminderTestRateLimited'|'ReminderDeliveryFailed'|'ReminderRunFailed'|'ReminderCapacityExceeded'} FailureKind */
/** @template T @typedef {{ok:true,value:T}|{ok:false,error:{kind:FailureKind}}} Result */
/** @typedef {'enabled'|'skipped'|'sent'|'delivery-failed'|'disabled-expired'} ReminderStatus */
/** @typedef {{deviceId:string,enabled:boolean,time:string,timeZone:string|null,skippedDate:string|null,lastStatus:ReminderStatus|null,publicKey:string|null}} ReminderSnapshot */
/** @typedef {{endpoint:string,keys:{p256dh:string,auth:string}}} Subscription */
/** @typedef {{type:'daily-reminder',id:string,expiresAt:string,test?:boolean}} PushPayload */
/** @typedef {{success:boolean,meta?:{changes?:number}}} Write */
/** @typedef {{bind:(...values:(string|number|null)[])=>Statement,first:()=>Promise<unknown>,all:()=>Promise<{success:boolean,results:readonly unknown[]}>,run:()=>Promise<Write>}} Statement */
/** @typedef {{prepare:(query:string)=>Statement}} Database */
/** @typedef {{owner_id:string,device_id:string,enabled:0|1,reminder_time:string,time_zone:string,skipped_date:string|null,last_status:ReminderStatus|null,last_reminded_date:string|null,last_test_at:string|null,revision:number,endpoint:string|null,p256dh:string|null,auth:string|null}} Row */
/** @typedef {{event:string,ownerId?:string,failureKind?:FailureKind,sent?:number,failed?:number}} ReminderLog */

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is string} */
function owner(value) {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= 256;
}
/** @param {unknown} value @returns {value is string} */
export function isReminderDevice(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}
/** @param {unknown} value @returns {value is string} */
function time(value) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}
/** @param {unknown} value @returns {value is string} */
function zone(value) {
  if (typeof value !== "string" || value.length > 100 || value.length === 0) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return false;
  }
}
/** @param {unknown} value @returns {value is string} */
function iso(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}
/** @param {unknown} value @returns {value is string|null} */
function dateOrNull(value) {
  return value === null ||
    (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value);
}
/** @param {unknown} value @param {number} length */
function key(value, length) {
  if (
    typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length !== Math.ceil(length * 8 / 6)
  ) return false;
  const bytes = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return bytes.length === length &&
    (length !== 65 || bytes.charCodeAt(0) === 4) &&
    btoa(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") ===
      value;
}

/** Deployment's explicit closed provider contract; never accepts arbitrary URLs.
 * @param {unknown} value @param {readonly string[]} allowedOrigins @returns {value is Subscription} */
export function isReminderSubscription(value, allowedOrigins) {
  if (
    !record(value) || Object.keys(value).sort().join() !== "endpoint,keys" ||
    typeof value.endpoint !== "string" || value.endpoint.length > 2048 ||
    !record(value.keys) ||
    Object.keys(value.keys).sort().join() !== "auth,p256dh" ||
    !key(value.keys.p256dh, 65) || !key(value.keys.auth, 16)
  ) return false;
  try {
    const url = new URL(value.endpoint);
    return url.protocol === "https:" && url.username === "" &&
      url.password === "" && url.port === "" && url.search === "" &&
      url.hash === "" && url.pathname !== "/" &&
      allowedOrigins.includes(url.origin);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return false;
  }
}

/** @param {Date} instant @param {string} timeZone */
export function reminderLocalClock(instant, timeZone) {
  if (
    !(instant instanceof Date) || !Number.isFinite(instant.getTime()) ||
    !zone(timeZone)
  ) throw new TypeError("ReminderClockInvalid");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const field = (/** @type {string} */ name) => {
    const part = parts.find((p) => p.type === name);
    if (!part) throw new TypeError("ReminderClockInvalid");
    return part.value;
  };
  return {
    day: `${field("year")}-${field("month")}-${field("day")}`,
    minute: Number(field("hour")) * 60 + Number(field("minute")),
  };
}
/** @param {FailureKind} kind @returns {Result<never>} */
function fail(kind) {
  return { ok: false, error: { kind } };
}
/** @param {Write} result */
function changes(result) {
  if (
    !result.success ||
    !Number.isSafeInteger(result.meta?.changes) || /** @type {number} */
    (result.meta?.changes) < 0
  ) throw new Error("ReminderWriteUnavailable");
  return /** @type {number} */ (result.meta?.changes);
}

/** The reminder feature's public persistence/scheduling contract.
 * @param {{database:Database,publicKey:string|null,allowedOrigins:readonly string[],now:()=>Date,logger:(entry:ReminderLog)=>void,sender:((subscription:Subscription,payload:PushPayload)=>Promise<boolean>)|null}} dependencies */
export function createReminderService(
  { database, publicKey, allowedOrigins, now, logger, sender },
) {
  if (
    typeof database?.prepare !== "function" || typeof now !== "function" ||
    typeof logger !== "function" ||
    (sender !== null && typeof sender !== "function") ||
    (publicKey !== null && !key(publicKey, 65)) ||
    !Array.isArray(allowedOrigins) ||
    (sender !== null && !allowedOrigins.length) ||
    allowedOrigins.some((origin) => {
      try {
        const url = new URL(origin);
        return url.protocol !== "https:" || url.origin !== origin ||
          !!url.port || url.hostname === "localhost" ||
          /^[\d.[\]:]+$/.test(url.hostname);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        return true;
      }
    })
  ) throw new TypeError("ReminderDependenciesInvalid");
  /** @param {unknown} raw @returns {Row|null} */
  function parse(raw) {
    if (raw === null) return null;
    if (
      !record(raw) || !owner(raw.owner_id) ||
      !isReminderDevice(raw.device_id) ||
      (raw.enabled !== 0 && raw.enabled !== 1) || !time(raw.reminder_time) ||
      !zone(raw.time_zone) || !dateOrNull(raw.skipped_date) ||
      !dateOrNull(raw.last_reminded_date) ||
      (raw.last_test_at !== null && !iso(raw.last_test_at)) ||
      typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) ||
      raw.revision < 1 ||
      !(raw.last_status === null ||
        ["enabled", "skipped", "sent", "delivery-failed", "disabled-expired"]
          .includes(/** @type {string} */ (raw.last_status)))
    ) throw new Error("ReminderDataInvalid");
    const sub = {
      endpoint: raw.endpoint,
      keys: { p256dh: raw.p256dh, auth: raw.auth },
    };
    if (
      !(raw.endpoint === null && raw.p256dh === null && raw.auth === null &&
        raw.enabled === 0) && !isReminderSubscription(sub, allowedOrigins)
    ) throw new Error("ReminderDataInvalid");
    return /** @type {Row} */ (raw);
  }
  /** @param {string} ownerId @param {string} deviceId */
  async function read(ownerId, deviceId) {
    const row = parse(
      await database.prepare(
        "SELECT * FROM daily_reminders WHERE owner_id = ? AND device_id = ?",
      ).bind(ownerId, deviceId).first(),
    );
    if (row && (row.owner_id !== ownerId || row.device_id !== deviceId)) {
      throw new Error("ReminderDataInvalid");
    }
    return row;
  }
  /** @param {Row|null} row @param {string} deviceId @returns {ReminderSnapshot} */
  function snapshot(row, deviceId) {
    return {
      deviceId,
      enabled: row?.enabled === 1,
      time: row === null ? "20:00" : row.reminder_time,
      timeZone: row === null ? null : row.time_zone,
      skippedDate: row === null ? null : row.skipped_date,
      lastStatus: row === null ? null : row.last_status,
      publicKey,
    };
  }
  /** @param {string} event @param {string|undefined} ownerId @param {FailureKind} kind */
  function failure(event, ownerId, kind) {
    logger({
      event: `${event}-failure`,
      ...(ownerId === undefined ? {} : { ownerId }),
      failureKind: kind,
    });
    return fail(kind);
  }
  /** @template T @param {string} event @param {string|undefined} ownerId @param {FailureKind} fallback @param {()=>Promise<Result<T>>} action @returns {Promise<Result<T>>} */
  async function execute(event, ownerId, fallback, action) {
    logger({
      event: `${event}-entry`,
      ...(ownerId === undefined ? {} : { ownerId }),
    });
    try {
      const result = await action();
      if (!result.ok) return failure(event, ownerId, result.error.kind);
      logger({
        event: `${event}-success`,
        ...(ownerId === undefined ? {} : { ownerId }),
      });
      return result;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return failure(
        event,
        ownerId,
        error.message === "ReminderDataInvalid"
          ? "ReminderDataInvalid"
          : error.message === "ReminderClockInvalid"
          ? "ReminderClockInvalid"
          : fallback,
      );
    }
  }
  function instant() {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("ReminderClockInvalid");
    }
    return value;
  }
  /** @param {unknown} ownerId @param {unknown} deviceId @returns {Promise<Result<ReminderSnapshot>>} */
  async function get(ownerId, deviceId) {
    if (!owner(ownerId) || !isReminderDevice(deviceId)) {
      return fail("ReminderDeviceInvalid");
    }
    return execute(
      "reminder-read",
      ownerId,
      "ReminderReadUnavailable",
      async () => ({
        ok: true,
        value: snapshot(await read(ownerId, deviceId), deviceId),
      }),
    );
  }
  /** @param {unknown} ownerId @param {unknown} command @returns {Promise<Result<ReminderSnapshot>>} */
  async function save(ownerId, command) {
    if (
      !owner(ownerId) || !record(command) ||
      Object.keys(command).sort().join() !==
        "action,deviceId,enabled,subscription,time,timeZone" ||
      command.action !== "save" || !isReminderDevice(command.deviceId) ||
      typeof command.enabled !== "boolean" || !time(command.time) ||
      !zone(command.timeZone) ||
      (command.subscription !== null &&
        !isReminderSubscription(command.subscription, allowedOrigins))
    ) return fail("ReminderCommandInvalid");
    const { deviceId, enabled, time: clock, timeZone, subscription: sub } =
      command;
    if (enabled && sub === null) return fail("ReminderSubscriptionRequired");
    if (enabled && (publicKey === null || sender === null)) {
      return fail("ReminderConfigurationMissing");
    }
    return execute(
      "reminder-save",
      ownerId,
      "ReminderWriteUnavailable",
      async () => {
        await read(ownerId, deviceId);
        const result = await database.prepare(
          "INSERT INTO daily_reminders (owner_id,device_id,enabled,reminder_time,time_zone,endpoint,p256dh,auth,last_status,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,device_id) DO UPDATE SET enabled=excluded.enabled,reminder_time=excluded.reminder_time,time_zone=excluded.time_zone,endpoint=excluded.endpoint,p256dh=excluded.p256dh,auth=excluded.auth,last_status=excluded.last_status,revision=daily_reminders.revision+1,updated_at=excluded.updated_at",
        ).bind(
          ownerId,
          deviceId,
          enabled ? 1 : 0,
          clock,
          timeZone,
          enabled && sub ? sub.endpoint : null,
          enabled && sub ? sub.keys.p256dh : null,
          enabled && sub ? sub.keys.auth : null,
          enabled ? "enabled" : null,
          instant().toISOString(),
        ).run();
        if (changes(result) !== 1) return fail("ReminderWriteUnavailable");
        return {
          ok: true,
          value: snapshot(await read(ownerId, deviceId), deviceId),
        };
      },
    );
  }
  /** @param {unknown} ownerId @param {unknown} command @param {'skip'|'test'} action */
  function validAction(ownerId, command, action) {
    return owner(ownerId) && record(command) &&
      Object.keys(command).sort().join() === "action,deviceId" &&
      command.action === action && isReminderDevice(command.deviceId);
  }
  /** @param {unknown} ownerId @param {unknown} command @returns {Promise<Result<ReminderSnapshot>>} */
  async function skip(ownerId, command) {
    if (!validAction(ownerId, command, "skip")) {
      return fail("ReminderCommandInvalid");
    }
    const ownerKey = /** @type {string} */ (ownerId),
      deviceId = /** @type {{deviceId:string}} */ (command).deviceId;
    return execute(
      "reminder-skip",
      ownerKey,
      "ReminderWriteUnavailable",
      async () => {
        const row = await read(ownerKey, deviceId);
        if (row === null || !row.enabled) return fail("ReminderNotEnabled");
        const current = instant();
        const changed = changes(
          await database.prepare(
            "UPDATE daily_reminders SET skipped_date=?,last_status='skipped',revision=revision+1,updated_at=? WHERE owner_id=? AND device_id=? AND revision=? AND enabled=1",
          ).bind(
            reminderLocalClock(current, row.time_zone).day,
            current.toISOString(),
            ownerKey,
            deviceId,
            row.revision,
          ).run(),
        );
        if (changed !== 1) return fail("ReminderConflict");
        return {
          ok: true,
          value: snapshot(await read(ownerKey, deviceId), deviceId),
        };
      },
    );
  }
  /** @param {Row} row @param {Date} current @param {boolean} testing @returns {Promise<Result<boolean>>} */
  async function deliver(row, current, testing) {
    if (sender === null || publicKey === null) {
      return fail("ReminderConfigurationMissing");
    }
    const sub = {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth },
    };
    if (!isReminderSubscription(sub, allowedOrigins)) {
      return fail("ReminderDataInvalid");
    }
    /** @type {ReminderStatus} */ let status;
    try {
      status = await sender(sub, {
          type: "daily-reminder",
          id: crypto.randomUUID(),
          expiresAt: new Date(current.getTime() + 3_600_000).toISOString(),
          ...(testing ? { test: true } : {}),
        })
        ? "sent"
        : "disabled-expired";
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      status = "delivery-failed";
    }
    // A concurrent disable/re-enrolment must not be overwritten by an old send.
    changes(
      await database.prepare(
        "UPDATE daily_reminders SET last_status=?,enabled=CASE WHEN ?='disabled-expired' THEN 0 ELSE enabled END,updated_at=? WHERE owner_id=? AND device_id=? AND revision=?",
      ).bind(
        status,
        status,
        current.toISOString(),
        row.owner_id,
        row.device_id,
        row.revision,
      ).run(),
    );
    logger({
      event: status === "sent"
        ? "reminder-send-success"
        : "reminder-send-failure",
      ownerId: row.owner_id,
      ...(status === "delivery-failed"
        ? { failureKind: /** @type {const} */ ("ReminderDeliveryFailed") }
        : {}),
    });
    return status === "delivery-failed"
      ? fail("ReminderDeliveryFailed")
      : { ok: true, value: status === "sent" };
  }
  /** @param {unknown} ownerId @param {unknown} command @returns {Promise<Result<ReminderSnapshot>>} */
  async function test(ownerId, command) {
    if (!validAction(ownerId, command, "test")) {
      return fail("ReminderCommandInvalid");
    }
    const ownerKey = /** @type {string} */ (ownerId),
      deviceId = /** @type {{deviceId:string}} */ (command).deviceId;
    return execute(
      "reminder-test",
      ownerKey,
      "ReminderWriteUnavailable",
      async () => {
        const row = await read(ownerKey, deviceId);
        if (!row?.enabled) return fail("ReminderNotEnabled");
        if (sender === null || publicKey === null) {
          return fail(
            "ReminderConfigurationMissing",
          );
        }
        const current = instant(),
          cutoff = new Date(current.getTime() - 60_000).toISOString();
        const claimed = changes(
          await database.prepare(
            "UPDATE daily_reminders SET last_test_at=? WHERE owner_id=? AND device_id=? AND revision=? AND enabled=1 AND (last_test_at IS NULL OR last_test_at<=?)",
          ).bind(
            current.toISOString(),
            ownerKey,
            deviceId,
            row.revision,
            cutoff,
          ).run(),
        );
        if (!claimed) return fail("ReminderTestRateLimited");
        const result = await deliver(row, current, true);
        if (!result.ok) return result;
        return {
          ok: true,
          value: snapshot(await read(ownerKey, deviceId), deviceId),
        };
      },
    );
  }
  /** @param {Row} row @param {Date} current @param {string} day */
  async function completed(row, current, day) {
    const data = await database.prepare(
      "SELECT (SELECT MAX(completed_at) FROM learner_review_batches WHERE owner_id=? AND status='completed' AND completed_at<=?) AS review_at,(SELECT MAX(completed_at) FROM learner_feed_batches WHERE owner_id=? AND status='completed' AND completed_at<=?) AS feed_at,EXISTS(SELECT 1 FROM learner_knowledge_state ls JOIN extraction_knowledge_points kp ON kp.owner_id=ls.owner_id AND kp.knowledge_id=ls.knowledge_id JOIN knowledge_workflow_quizzes q ON q.owner_id=kp.owner_id AND q.knowledge_id=kp.knowledge_id AND q.source_id=kp.source_id AND q.source_revision=kp.source_revision AND q.status='published' JOIN learning_generation_tasks t ON t.owner_id=q.owner_id AND t.item_id=q.knowledge_id AND t.status='published' JOIN library_sources s ON s.owner_id=kp.owner_id AND s.source_id=kp.source_id AND s.state='active' WHERE ls.owner_id=? AND ls.studied_at IS NOT NULL AND ls.due_at IS NOT NULL AND ls.due_at<=?) AS due",
    ).bind(
      row.owner_id,
      current.toISOString(),
      row.owner_id,
      current.toISOString(),
      row.owner_id,
      current.toISOString(),
    ).first();
    if (
      !record(data) || (data.review_at !== null && !iso(data.review_at)) ||
      (data.feed_at !== null && !iso(data.feed_at)) ||
      (data.due !== 0 && data.due !== 1)
    ) throw new Error("ReminderDataInvalid");
    return (data.review_at !== null &&
      reminderLocalClock(
          new Date(/** @type {string} */ (data.review_at)),
          row.time_zone,
        ).day === day) ||
      (data.due === 0 && data.feed_at !== null &&
        reminderLocalClock(
            new Date(/** @type {string} */ (data.feed_at)),
            row.time_zone,
          ).day === day);
  }
  /** @returns {Promise<Result<{sent:number}>>} */
  async function run() {
    return execute("reminder-run", undefined, "ReminderRunFailed", async () => {
      if (sender === null || publicKey === null) {
        return fail("ReminderConfigurationMissing");
      }
      const current = instant();
      // ponytail: personal-use scan capped at 1000 devices; indexed due-at queue
      // and bounded parallel delivery are needed before a multi-user launch.
      const loaded = await database.prepare(
        "SELECT * FROM daily_reminders WHERE enabled=1 LIMIT 1001",
      ).all();
      if (!loaded.success || !Array.isArray(loaded.results)) {
        return fail("ReminderReadUnavailable");
      }
      if (loaded.results.length > 1000) return fail("ReminderCapacityExceeded");
      const rows = loaded.results.map(parse);
      let sent = 0, failed = 0;
      for (const row of rows) {
        if (row === null) return fail("ReminderDataInvalid");
        const clock = reminderLocalClock(current, row.time_zone),
          scheduled = Number(row.reminder_time.slice(0, 2)) * 60 +
            Number(row.reminder_time.slice(3));
        if (
          clock.minute < scheduled || clock.minute > scheduled + 60 ||
          row.skipped_date === clock.day || row.last_reminded_date === clock.day
        ) continue;
        if (await completed(row, current, clock.day)) continue;
        // Claim before network I/O. Unknown send outcomes are not retried today:
        // avoiding duplicate nudges is preferable to a second possible delivery.
        const claimed = changes(
          await database.prepare(
            "UPDATE daily_reminders SET last_reminded_date=?,last_status='delivery-failed',updated_at=? WHERE owner_id=? AND device_id=? AND revision=? AND enabled=1 AND (skipped_date IS NULL OR skipped_date<>?) AND (last_reminded_date IS NULL OR last_reminded_date<>?)",
          ).bind(
            clock.day,
            current.toISOString(),
            row.owner_id,
            row.device_id,
            row.revision,
            clock.day,
            clock.day,
          ).run(),
        );
        if (!claimed) continue;
        const delivered = await deliver(row, current, false);
        if (delivered.ok) { if (delivered.value) sent++; }
        else failed++;
      }
      logger({ event: "reminder-run-counts", sent, failed });
      return failed
        ? fail("ReminderDeliveryFailed")
        : { ok: true, value: { sent } };
    });
  }
  return Object.freeze({ get, save, skip, test, run });
}
