// @ts-check
import { createReminderClient } from "../src/features/reminders/client.js";

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const publicKey = `B${"A".repeat(86)}`;

class Storage {
  /** @type {Map<string,string>} */ values = new Map();
  failRead = false;
  failWrite = false;
  failRemove = false;
  /** @param {string} key */ getItem(key) {
    if (this.failRead) throw new Error("read");
    return this.values.get(key) ?? null;
  }
  /** @param {string} key @param {string} value */ setItem(key, value) {
    if (this.failWrite) throw new Error("write");
    this.values.set(key, value);
  }
  /** @param {string} key */ removeItem(key) {
    if (this.failRemove) throw new Error("remove");
    this.values.delete(key);
  }
}

class Gate {
  /** @type {Promise<void>} */ waiting;
  /** @type {() => void} */ release;
  constructor() {
    this.release = () => {};
    this.waiting = new Promise((resolve) => {
      this.release = () => resolve();
    });
  }
}

/** @param {string} id @param {Record<string,unknown>} [changes] */
function snapshot(id, changes = {}) {
  return {
    deviceId: id,
    enabled: false,
    time: "20:00",
    timeZone: null,
    skippedDate: null,
    lastStatus: null,
    publicKey: null,
    ...changes,
  };
}
/** @param {unknown} body @param {number} [status] */
function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
/** @param {RequestInfo|URL} url */
function loadId(url) {
  return new URL(String(url), "https://test").searchParams.get("deviceId") ??
    "";
}
/** @param {RequestInit|undefined} init */
function postId(init) {
  return JSON.parse(String(init?.body)).deviceId;
}
/** @param {"denied"|"granted"} permission */
function pushGlobals(permission) {
  const notification = globalThis.Notification,
    pushManager = globalThis.PushManager;
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: { permission, requestPermission: async () => permission },
  });
  Object.defineProperty(globalThis, "PushManager", {
    configurable: true,
    value: class {},
  });
  return () => {
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: notification,
    });
    Object.defineProperty(globalThis, "PushManager", {
      configurable: true,
      value: pushManager,
    });
  };
}

Deno.test("rejects malformed reminder snapshots before any subsequent action", async () => {
  const invalid = [
    { deviceId: "wrong" },
    { time: "24:00" },
    { timeZone: "Mars/Olympus" },
    { skippedDate: "2026-02-30" },
    { publicKey: "AA" },
  ];
  for (const changes of invalid) {
    let posts = 0;
    const client = createReminderClient({
      ownerId: "owner",
      storage: new Storage(),
      navigator: { onLine: true },
      fetch: async (url, init) => {
        if (init?.method === "POST") posts += 1;
        return reply({ result: snapshot(loadId(url), changes) });
      },
    });
    await client.load();
    await client.save({ enabled: false, time: "20:00" });
    assert(
      client.view().state === "error" && posts === 0,
      "Invalid snapshots must not become actionable state.",
    );
  }
});

Deno.test("uses owner-scoped UUID storage and reports corrupt or unavailable storage", async () => {
  const storage = new Storage();
  const first = createReminderClient({
    ownerId: "first",
    storage,
    navigator: { onLine: true },
    fetch: /** @this {void} */ async function (url) {
      assert(
        this === undefined,
        "Native fetch must not receive a dependency-object receiver.",
      );
      return reply({ result: snapshot(loadId(url)) });
    },
  });
  const second = createReminderClient({
    ownerId: "second",
    storage,
    navigator: { onLine: true },
    fetch: async (url) => reply({ result: snapshot(loadId(url)) }),
  });
  await Promise.all([first.load(), second.load()]);
  assert(
    storage.values.has("resonance:reminder:first:device") &&
      storage.values.has("resonance:reminder:second:device"),
    "Each owner needs an independent device id.",
  );
  const corrupt = new Storage();
  corrupt.values.set("resonance:reminder:owner:device", "not-a-uuid");
  let corruptFetches = 0;
  const blocked = createReminderClient({
    ownerId: "owner",
    storage: corrupt,
    navigator: { onLine: true },
    fetch: async () => {
      corruptFetches += 1;
      return reply({});
    },
  });
  await blocked.load();
  assert(
    blocked.view().state === "error" && corruptFetches === 0,
    "Corrupt device ids must not be replaced silently.",
  );
  const unreadable = new Storage();
  unreadable.failRead = true;
  const unavailable = createReminderClient({
    ownerId: "owner",
    storage: unreadable,
    navigator: { onLine: true },
    fetch: async () => reply({}),
  });
  await unavailable.load();
  assert(
    unavailable.view().state === "error",
    "Storage read failures must leave reminders unavailable.",
  );
});

Deno.test("load failures, unsupported browsers, and denied permission never post", async () => {
  let posts = 0;
  const failed = createReminderClient({
    ownerId: "owner",
    storage: new Storage(),
    navigator: { onLine: true },
    fetch: async () => reply({ error: "Unavailable" }, 503),
  });
  await failed.syncTimeZone();
  assert(
    posts === 0 && failed.view().state === "error",
    "Timezone sync must not post from a failed or stale load.",
  );
  const restore = pushGlobals("denied");
  try {
    const denied = createReminderClient({
      ownerId: "owner",
      storage: new Storage(),
      navigator: {
        onLine: true,
        serviceWorker: {
          ready: Promise.resolve({
            pushManager: {
              subscribe: async () => subscription(),
              getSubscription: async () => null,
            },
          }),
          getRegistration: async () => undefined,
        },
      },
      fetch: async (url, init) => {
        if (init?.method === "POST") posts += 1;
        return reply({ result: snapshot(loadId(url), { publicKey }) });
      },
    });
    await denied.load();
    await denied.save({ enabled: true, time: "20:00" });
    assert(
      posts === 0 && denied.view().message.includes("blocked"),
      "Denied permission must not call the API or push provider.",
    );
  } finally {
    restore();
  }
});

Deno.test("timezone sync normalizes subscriptions and duplicate saves are single-flight", async () => {
  const restore = pushGlobals("granted");
  try {
    /** @type {string[]} */ const bodies = [];
    const gate = new Gate();
    const registration = {
      pushManager: {
        subscribe: async () => subscription(),
        getSubscription: async () => subscription(),
      },
    };
    const client = createReminderClient({
      ownerId: "owner",
      storage: new Storage(),
      navigator: {
        onLine: true,
        serviceWorker: {
          ready: Promise.resolve(registration),
          getRegistration: async () => registration,
        },
      },
      fetch: async (url, init) => {
        if (init?.method === "POST") {
          bodies.push(String(init.body));
          await gate.waiting;
        }
        const id = init?.method === "POST" ? postId(init) : loadId(url);
        return reply({
          result: snapshot(id, {
            enabled: true,
            timeZone: "Pacific/Kiritimati",
            publicKey,
          }),
        });
      },
    });
    const syncing = client.syncTimeZone();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const duplicate = client.save({ enabled: true, time: "20:00" });
    if (bodies.length !== 1) throw new Error("Post was not started");
    gate.release();
    await Promise.all([syncing, duplicate]);
    assert(
      bodies.length === 1 && !bodies[0].includes("expirationTime") &&
        bodies[0].includes('"endpoint":"https://push.example/sub"'),
      `Sync must submit one strict subscription payload: ${bodies.join("|")}`,
    );
  } finally {
    restore();
  }
});

Deno.test("expired provider status and failed local unsubscribe are reported honestly", async () => {
  const restore = pushGlobals("granted");
  try {
    /** @type {string[]} */ const order = [];
    const registration = {
      pushManager: {
        subscribe: async () => subscription(),
        getSubscription: async () => ({
          ...subscription(),
          unsubscribe: async () => false,
        }),
      },
    };
    const client = createReminderClient({
      ownerId: "owner",
      storage: new Storage(),
      navigator: {
        onLine: true,
        serviceWorker: {
          ready: Promise.resolve(registration),
          getRegistration: async () => registration,
        },
      },
      fetch: async (url, init) => {
        if (init?.method === "POST") order.push("server");
        const id = init?.method === "POST" ? postId(init) : loadId(url);
        return reply({
          result: snapshot(id, {
            lastStatus: init?.method === "POST" ? "disabled-expired" : null,
            publicKey,
          }),
        });
      },
    });
    await client.load();
    await client.test();
    assert(
      client.view().message.includes("expired"),
      "Expired provider status must not be reported as a successful test.",
    );
    await client.save({ enabled: false, time: "20:00" });
    assert(
      order.length === 2 && client.view().message.includes("server"),
      "Disable must save first and disclose failed browser cleanup.",
    );
  } finally {
    restore();
  }
});

function subscription() {
  return {
    toJSON: () => ({
      endpoint: "https://push.example/sub",
      keys: { p256dh: "key", auth: "auth" },
      expirationTime: 1,
    }),
    unsubscribe: async () => true,
  };
}

Deno.test("storage write and cleanup failures remain visible after server success", async () => {
  const inaccessible = new Storage();
  inaccessible.failWrite = true;
  const missing = createReminderClient({
    ownerId: "owner",
    storage: inaccessible,
    navigator: { onLine: true },
    fetch: async () => {
      throw new Error("UnexpectedFetch");
    },
  });
  await missing.load();
  assert(
    missing.view().state === "error",
    "Device storage failure must block API use.",
  );
  const restore = pushGlobals("granted");
  try {
    for (const enabled of [true, false]) {
      const storage = new Storage();
      const registration = {
        pushManager: {
          subscribe: async () => subscription(),
          getSubscription: async () => subscription(),
        },
      };
      const client = createReminderClient({
        ownerId: "owner",
        storage,
        navigator: {
          onLine: true,
          serviceWorker: {
            ready: Promise.resolve(registration),
            getRegistration: async () => registration,
          },
        },
        fetch: async (url, init) =>
          reply({
            result: snapshot(
              init?.method === "POST" ? postId(init) : loadId(url),
              {
                enabled: init?.method === "POST" ? enabled : false,
                timeZone: "UTC",
                publicKey,
              },
            ),
          }),
      });
      await client.load();
      storage.failWrite = enabled;
      storage.failRemove = !enabled;
      await client.save({ enabled, time: "20:00" });
      assert(
        client.view().snapshot?.enabled === enabled,
        "Server confirmation must be retained.",
      );
      assert(
        /could not finish|cleanup failed/.test(client.view().message),
        "Storage failure must not claim full success.",
      );
    }
  } finally {
    restore();
  }
});

Deno.test("revoked permission prevents timezone writes after a successful refresh", async () => {
  const restore = pushGlobals("denied");
  let posts = 0;
  try {
    const registration = {
      pushManager: {
        subscribe: async () => subscription(),
        getSubscription: async () => subscription(),
      },
    };
    const client = createReminderClient({
      ownerId: "owner",
      storage: new Storage(),
      navigator: {
        onLine: true,
        serviceWorker: {
          ready: Promise.resolve(registration),
          getRegistration: async () => registration,
        },
      },
      fetch: async (url, init) => {
        if (init?.method === "POST") posts++;
        return reply({
          result: snapshot(loadId(url), {
            enabled: true,
            timeZone: "Pacific/Kiritimati",
            publicKey,
          }),
        });
      },
    });
    await client.syncTimeZone();
    assert(
      posts === 0 && client.view().message.includes("blocked"),
      "Revoked permission must be visible and cannot resubscribe.",
    );
  } finally {
    restore();
  }
});

Deno.test("API and service-worker readiness have bounded timeout failures", async () => {
  const restore = pushGlobals("granted");
  try {
    const network = createReminderClient({
      ownerId: "owner",
      storage: new Storage(),
      navigator: { onLine: true },
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          )
        ),
    });
    /** @type {Promise<import('../src/features/reminders/client.js').ReminderRegistration>} */ const pending =
      new Promise(() => {});
    const worker = createReminderClient({
      ownerId: "owner",
      storage: new Storage(),
      navigator: {
        onLine: true,
        serviceWorker: {
          ready: pending,
          getRegistration: async () => undefined,
        },
      },
      fetch: async (url) =>
        reply({ result: snapshot(loadId(url), { publicKey }) }),
    });
    await worker.load();
    await Promise.all([
      network.load(),
      worker.save({ enabled: true, time: "20:00" }),
    ]);
    assert(
      network.view().message.includes("too long") &&
        worker.view().message.includes("timed out"),
      "Both waits must return actionable timeout states.",
    );
  } finally {
    restore();
  }
});

Deno.test("explicit enable is unsupported without browser APIs and default permission waits for save", async () => {
  let posts = 0;
  const unsupported = createReminderClient({
    ownerId: "owner",
    storage: new Storage(),
    navigator: { onLine: true },
    fetch: async (url, init) => {
      if (init?.method === "POST") posts += 1;
      return reply({ result: snapshot(loadId(url), { publicKey }) });
    },
  });
  await unsupported.load();
  await unsupported.save({ enabled: true, time: "20:00" });
  assert(
    posts === 0 && unsupported.view().message.includes("can’t receive"),
    "Explicit enable must explain unsupported APIs without calling the server.",
  );
  const originalNotification = globalThis.Notification,
    originalPushManager = globalThis.PushManager;
  let prompts = 0;
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: {
      permission: "default",
      requestPermission: async () => {
        prompts += 1;
        return "denied";
      },
    },
  });
  Object.defineProperty(globalThis, "PushManager", {
    configurable: true,
    value: class {},
  });
  try {
    const registration = {
      pushManager: {
        subscribe: async () => subscription(),
        getSubscription: async () => null,
      },
    };
    const client = createReminderClient({
      ownerId: "owner",
      storage: new Storage(),
      navigator: {
        onLine: true,
        serviceWorker: {
          ready: Promise.resolve(registration),
          getRegistration: async () => registration,
        },
      },
      fetch: async (url) =>
        reply({ result: snapshot(loadId(url), { publicKey }) }),
    });
    await client.load();
    assert(
      prompts === 0,
      "Loading Settings must never prompt for notification permission.",
    );
    await client.save({ enabled: true, time: "20:00" });
    assert(
      prompts === 1,
      "Only an explicit enabled save may request permission.",
    );
  } finally {
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: originalNotification,
    });
    Object.defineProperty(globalThis, "PushManager", {
      configurable: true,
      value: originalPushManager,
    });
  }
});

Deno.test("offline, revoked, and stale sync states never post a timezone update", async () => {
  let posts = 0, loads = 0;
  const offline = createReminderClient({
    ownerId: "owner",
    storage: new Storage(),
    navigator: { onLine: false },
    fetch: async () => reply({}, 503),
  });
  await offline.load();
  assert(
    offline.view().message.includes("offline"),
    "Offline loads must explain that the browser is disconnected.",
  );
  const restore = pushGlobals("denied");
  try {
    const registration = {
      pushManager: {
        subscribe: async () => subscription(),
        getSubscription: async () => subscription(),
      },
    };
    const client = createReminderClient({
      ownerId: "owner",
      storage: new Storage(),
      navigator: {
        onLine: true,
        serviceWorker: {
          ready: Promise.resolve(registration),
          getRegistration: async () => registration,
        },
      },
      fetch: async (url, init) => {
        loads += 1;
        if (init?.method === "POST") posts += 1;
        return loads === 1
          ? reply({
            result: snapshot(loadId(url), {
              enabled: true,
              timeZone: "Etc/GMT",
              publicKey,
            }),
          })
          : reply({ error: "Unavailable" }, 503);
      },
    });
    await client.load();
    await client.syncTimeZone();
    assert(
      posts === 0 && client.view().state === "error",
      "A failed refresh or revoked permission must not use stale enrollment to POST.",
    );
  } finally {
    restore();
  }
});
