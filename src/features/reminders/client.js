// @ts-check
/** @typedef {{deviceId:string,enabled:boolean,time:string,timeZone:string|null,skippedDate:string|null,lastStatus:null|"enabled"|"skipped"|"sent"|"delivery-failed"|"disabled-expired",publicKey:string|null}} ReminderSnapshot */
/** @typedef {{getItem:(key:string)=>string|null,setItem:(key:string,value:string)=>void,removeItem:(key:string)=>void}} ReminderStorage */
/** @typedef {{toJSON:()=>PushSubscriptionJSON,unsubscribe:()=>Promise<boolean>}} ReminderSubscription */
/** @typedef {{pushManager:{subscribe:(options:PushSubscriptionOptionsInit)=>Promise<ReminderSubscription>,getSubscription:()=>Promise<ReminderSubscription|null>}}} ReminderRegistration */
/** @typedef {{onLine:boolean,serviceWorker?:{ready:Promise<ReminderRegistration>,getRegistration:()=>Promise<ReminderRegistration|undefined>}}} ReminderNavigator */
/** @param {{readonly ownerId:string,readonly fetch:typeof fetch,readonly storage:ReminderStorage,readonly navigator:ReminderNavigator}} d */
export function createReminderClient(d) {
  if (
    !d || typeof d.ownerId !== "string" || !d.ownerId ||
    typeof d.fetch !== "function" || !d.storage || !d.navigator
  ) throw new TypeError("Reminder client dependencies are invalid.");
  const fetchReminder = d.fetch;
  const key = `resonance:reminder:${d.ownerId}:device`,
    enrolledKey = `resonance:reminder:${d.ownerId}:enrolled`,
    sw = d.navigator.serviceWorker,
    supported = sw !== undefined && "PushManager" in globalThis &&
      "Notification" in globalThis;
  /** @type {ReminderSnapshot|null} */ let snapshot =
    null; /** @type {"idle"|"loading"|"ready"|"saving"|"error"} */
  let state = "idle";
  let message = "", deviceId = "";
  try {
    const saved = d.storage.getItem(key);
    if (saved !== null && !uuid(saved)) {
      throw new Error("ReminderDeviceInvalid");
    }
    deviceId = saved ?? crypto.randomUUID();
    if (saved === null) d.storage.setItem(key, deviceId);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    deviceId = "";
    state = "error";
    message = "Reminder settings can’t be stored in this browser.";
  }
  const view = () => ({
    snapshot,
    state,
    message,
    supported,
    configured: snapshot?.publicKey != null,
    permission: supported ? Notification.permission : "unsupported",
  });
  /** @param {"load"|"save"|"skip"|"test"} action @param {Record<string,unknown>} [body] */
  async function request(action, body = {}) {
    if (!deviceId) throw new Error("Storage");
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetchReminder(
        action === "load"
          ? `/api/reminders?deviceId=${encodeURIComponent(deviceId)}`
          : "/api/reminders",
        {
          method: action === "load" ? "GET" : "POST",
          headers: action === "load" ? { accept: "application/json" } : {
            accept: "application/json",
            "content-type": "application/json",
          },
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
          ...(action === "load"
            ? {}
            : { body: JSON.stringify({ action, deviceId, ...body }) }),
        },
      );
      /** @type {unknown} */ let payload;
      try {
        payload = await response.json();
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        throw new Error("Malformed", { cause: error });
      }
      if (!response.ok) throw new Error(apiError(payload));
      if (
        !payload || typeof payload !== "object" || !("result" in payload) ||
        !snapshotValid(payload.result, deviceId)
      ) throw new Error("Invalid");
      const valid = payload.result;
      snapshot = valid;
      return valid;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new Error(controller.signal.aborted ? "Timeout" : error.message);
    } finally {
      clearTimeout(timer);
    }
  }
  async function load() {
    if (state === "loading" || state === "saving") return view();
    state = "loading";
    message = "";
    try {
      await request("load");
      state = "ready";
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      state = "error";
      message = !d.navigator.onLine
        ? "You’re offline. Reconnect to manage reminders."
        : error.message === "Timeout"
        ? "Reminders took too long to load. Try again."
        : error.message === "Malformed" || error.message === "Invalid"
        ? "Reminder settings couldn’t be read. Try again."
        : "Reminders could not load. Try again.";
    }
    return view();
  }
  /** @param {unknown} input */
  async function save(input) {
    if (state === "saving" || state === "loading") return view();
    if (!saveInput(input)) {
      message = "Choose a valid reminder time.";
      return view();
    }
    if (!snapshot || state === "error") return load();
    state = "saving";
    message = "";
    let saved = false;
    try {
      /** @type {{endpoint:string,keys:{p256dh:string,auth:string}}|null} */ let subscription =
        null;
      if (input.enabled) {
        if (!supported) throw new Error("Unsupported");
        if (!snapshot.publicKey) throw new Error("Unconfigured");
        if (
          Notification.permission === "denied" ||
          (Notification.permission !== "granted" &&
            await Notification.requestPermission() !== "granted")
        ) throw new Error("Permission");
        const registration = await timed(sw.ready);
        subscription = normalized(
          await timed(
            registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: base64(snapshot.publicKey),
            }),
          ),
        );
      }
      await request("save", {
        enabled: input.enabled,
        time: input.time,
        timeZone: zone(),
        subscription,
      });
      saved = true;
      if (input.enabled) d.storage.setItem(enrolledKey, "true");
      else d.storage.removeItem(enrolledKey);
      if (!input.enabled && sw) {
        const registration = await timed(sw.getRegistration());
        const push = await timed(
          registration?.pushManager.getSubscription() ?? Promise.resolve(null),
        );
        if (push && !await timed(push.unsubscribe())) {
          throw new Error("Unsubscribe");
        }
      }
      message = input.enabled
        ? "This device will remind you at the selected time."
        : "Reminders are off on this device.";
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      message = saved
        ? (input.enabled
          ? "Reminder saved, but browser setup could not finish. Reopen Settings to check it."
          : "Reminders are off on the server, but browser cleanup failed. Try saving again.")
        : actionMessage(error.message);
    }
    state = "ready";
    return view();
  }
  /** @param {"skip"|"test"} kind @param {string} success */
  async function action(kind, success) {
    if (state === "saving" || state === "loading") return view();
    state = "saving";
    message = "";
    try {
      const result = await request(kind);
      state = "ready";
      message = result.lastStatus === "disabled-expired"
        ? "This subscription expired. Enable reminders again."
        : success;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      state = "ready";
      message = actionMessage(error.message);
    }
    return view();
  }
  async function syncTimeZone() {
    if (!deviceId || state === "saving" || state === "loading") return view();
    const loaded = await load();
    if (loaded.state !== "ready" || !snapshot?.enabled || !supported) {
      return view();
    }
    state = "saving";
    try {
      if (Notification.permission !== "granted") throw new Error("Permission");
      const registration = await timed(sw.getRegistration());
      const push = await timed(
        registration?.pushManager.getSubscription() ?? Promise.resolve(null),
      );
      if (!push) throw new Error("SubscriptionMissing");
      if (snapshot.timeZone !== zone()) {
        await request("save", {
          enabled: true,
          time: snapshot.time,
          timeZone: zone(),
          subscription: normalized(push),
        });
      }
      state = "ready";
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      state = "ready";
      message = actionMessage(error.message);
    }
    return view();
  }
  function enrolled() {
    try {
      return d.storage.getItem(enrolledKey) === "true";
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      state = "error";
      message = "Reminder settings can’t be read in this browser.";
      return false;
    }
  }
  return Object.freeze({
    load,
    save,
    skip: () => action("skip", "Today’s reminder is skipped."),
    test: () => action("test", "A test notification is on its way."),
    syncTimeZone,
    enrolled,
    view,
  });
}
/** @param {unknown} v @returns {v is string} */ function uuid(v) {
  return typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(v);
}
/** @param {unknown} v @returns {v is {enabled:boolean,time:string}} */ function saveInput(
  v,
) {
  return !!v && typeof v === "object" &&
    typeof /** @type {{enabled?:unknown}} */ (v).enabled === "boolean" &&
    time(/** @type {{time?:unknown}} */ (v).time);
}
/** @param {unknown} v */ function time(v) {
  if (typeof v !== "string" || !/^\d{2}:\d{2}$/.test(v)) return false;
  const [h, m] = v.split(":").map(Number);
  return h < 24 && m < 60;
}
/** @param {unknown} v @param {string} id @returns {v is ReminderSnapshot} */ function snapshotValid(
  v,
  id,
) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const x = /** @type {Record<string,unknown>} */ (v);
  return x.deviceId === id && typeof x.enabled === "boolean" && time(x.time) &&
    (x.timeZone === null
      ? !x.enabled
      : typeof x.timeZone === "string" && validZone(x.timeZone)) &&
    (x.skippedDate === null ||
      typeof x.skippedDate === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(x.skippedDate) &&
        Number.isFinite(Date.parse(x.skippedDate)) &&
        new Date(x.skippedDate).toISOString().slice(0, 10) === x.skippedDate) &&
    (x.lastStatus === null ||
      ["enabled", "skipped", "sent", "delivery-failed", "disabled-expired"]
        .includes(/** @type {string} */ (x.lastStatus))) &&
    (x.publicKey === null ||
      typeof x.publicKey === "string" &&
        /^B[A-Za-z0-9_-]{86}$/.test(x.publicKey));
}
/** @param {string} v */ function validZone(v) {
  if (!v || v.length > 100) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: v });
    return true;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return false;
  }
}
function zone() {
  const value = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!validZone(value)) throw new Error("Timezone");
  return value;
}
/** @param {ReminderSubscription} p */ function normalized(p) {
  const x = p.toJSON();
  if (!x.endpoint || !x.keys?.p256dh || !x.keys.auth) {
    throw new Error("SubscriptionInvalid");
  }
  return {
    endpoint: x.endpoint,
    keys: { p256dh: x.keys.p256dh, auth: x.keys.auth },
  };
}
/** @template T @param {Promise<T>} promise @returns {Promise<T>} */ function timed(
  promise,
) {
  let timer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
  const timeout = new Promise(
    /** @param {(value:never)=>void} _resolve */ (_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Timeout")), 10_000);
    },
  );
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}
/** @param {string} key */ function base64(key) {
  const raw = atob(
    key.replace(/-/g, "+").replace(/_/g, "/").padEnd(
      Math.ceil(key.length / 4) * 4,
      "=",
    ),
  );
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
/** @param {unknown} v */ function apiError(v) {
  return v && typeof v === "object" &&
      typeof /** @type {{error?:unknown}} */ (v).error === "string"
    ? `Api:${/** @type {{error:string}} */ (v).error}`
    : "Request";
}
/** @param {string} e */ function actionMessage(e) {
  return e === "Unsupported"
    ? "This browser can’t receive reminders."
    : e === "Unconfigured" || e === "Api:ReminderConfigurationMissing"
    ? "Reminders aren’t configured yet."
    : e === "Permission"
    ? "Notifications are blocked for this browser. Enable them in browser settings to try again."
    : e === "Timeout"
    ? "The reminder request timed out. Try again."
    : e === "SubscriptionMissing"
    ? "This browser no longer has a reminder subscription. Save the reminder again."
    : e === "Api:ReminderTestRateLimited"
    ? "Wait a minute before sending another test notification."
    : e === "Api:ReminderDeliveryFailed"
    ? "The push service could not confirm the send. Delivery may be delayed or unavailable."
    : "Couldn’t update the reminder. Try again.";
}
