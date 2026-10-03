// @ts-check

/** @param {unknown} actual @param {unknown} expected */
function equal(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

/** @param {Promise<unknown>} promise @param {string} message */
async function rejects(promise, message) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error && error.message === message) return;
    throw error;
  }
  throw new Error(`Expected ${message}`);
}

/** @typedef {{url:string,postMessage:(value:unknown)=>void,focus:()=>Promise<void>}} Client */
async function harness() {
  const source = await Deno.readTextFile(
    new URL("../service-worker.js", import.meta.url),
  );
  /** @type {{title:string,options:NotificationOptions & {renotify:boolean}}[]} */
  const shown = [];
  /** @type {string[]} */
  const opened = [];
  /** @type {Client[]} */
  const windows = [];
  /** @type {Map<string,(event:unknown)=>void>} */
  const handlers = new Map();
  const clock = 1_800_000_000_000;
  let displayFailure = false;
  const scope = {
    addEventListener: (
      /** @type {string} */ name,
      /** @type {(event:unknown)=>void} */ callback,
    ) => handlers.set(name, callback),
    registration: {
      scope: "https://app.example/",
      async showNotification(
        /** @type {string} */ title,
        /** @type {NotificationOptions & {renotify:boolean}} */ options,
      ) {
        if (displayFailure) throw new Error("PermissionRevoked");
        shown.push({ title, options });
      },
    },
    clients: {
      async matchAll() {
        return windows;
      },
      async openWindow(/** @type {string} */ url) {
        opened.push(url);
      },
    },
  };
  class Clock extends Date {
    /** @override */
    static now() {
      return clock;
    }
  }
  new Function("self", "Date", source)(scope, Clock);
  /** @param {string} name @param {object} fields */
  async function dispatch(name, fields) {
    /** @type {Promise<unknown>[]} */
    const waits = [];
    const callback = handlers.get(name);
    if (!callback) throw new Error(`Missing handler ${name}`);
    callback({
      ...fields,
      waitUntil: (/** @type {Promise<unknown>} */ value) => waits.push(value),
    });
    await Promise.all(waits);
  }
  const payload = {
    type: "daily-reminder",
    id: "device:2027-01-15",
    expiresAt: new Date(clock + 60_000).toISOString(),
  };
  return {
    shown,
    opened,
    windows,
    dispatch,
    payload,
    clock,
    failDisplay: () => {
      displayFailure = true;
    },
  };
}

Deno.test("push shows generic content with stable tag; never trusts payload content or URL", async () => {
  const h = await harness();
  await h.dispatch("push", {
    data: {
      json: () => ({
        ...h.payload,
        body: "PRIVATE SOURCE",
        url: "https://evil.example",
      }),
    },
  });
  equal(h.shown[0].title, "Resonance");
  equal(
    h.shown[0].options.body,
    "What do you remember? Tap to start your daily review.",
  );
  equal(h.shown[0].options.tag, `resonance-reminder:${h.payload.id}`);
  equal(h.shown[0].options.renotify, false);
  equal(h.shown[0].options.icon, "https://app.example/assets/app-icon-192.png");
  await h.dispatch("push", {
    data: { json: () => ({ ...h.payload, test: true }) },
  });
  equal(h.shown[1].options.body, "Your reminder is working. Tap to try your daily retrieval quiz.");
  for (const [type,body] of [["source-ready","Your knowledge and quizzes are ready. Tap to explore them in Library."],["source-attention","A source needs your attention. Tap to open Library and see the next step."]]) {
    await h.dispatch("push",{data:{json:()=>({...h.payload,type,body:"PRIVATE",url:"https://evil.example"})}});
    equal(h.shown.at(-1)?.options.body,body);
    equal(h.shown.at(-1)?.options.tag,`resonance-source:${h.payload.id}`);
  }
});

Deno.test("push drops expired messages and rejects malformed or unbounded lifetime messages", async () => {
  const h = await harness();
  await h.dispatch("push", {
    data: {
      json: () => ({
        ...h.payload,
        expiresAt: new Date(h.clock).toISOString(),
      }),
    },
  });
  equal(h.shown.length, 0);
  for (
    const payload of [
      null,
      [],
      {},
      { ...h.payload, type: "unknown" },
      { ...h.payload, id: "<script>" },
      { ...h.payload, expiresAt: "invalid" },
      {
        ...h.payload,
        expiresAt: new Date(h.clock + 66 * 60_000).toISOString(),
      },
      { ...h.payload, test: "yes" },
      { ...h.payload, type: "source-ready", test: true },
    ]
  ) {
    await rejects(
      h.dispatch("push", { data: { json: () => payload } }),
      "ReminderPushInvalid",
    );
  }
  await rejects(
    h.dispatch("push", {
      data: {
        json: () => {
          throw new SyntaxError("bad JSON");
        },
      },
    }),
    "ReminderPushInvalid",
  );
  await rejects(h.dispatch("push", {}), "ReminderPushInvalid");
  for (
    const expiresAt of [
      "2027-01-15",
      "January 15, 2027",
      "2027-01-15T00:00:00",
      "2027-02-30T00:00:00.000Z",
      "2027-01-15T00:00:00.000+00:00",
    ]
  ) {
    await rejects(
      h.dispatch("push", {
        data: { json: () => ({ ...h.payload, expiresAt }) },
      }),
      "ReminderPushInvalid",
    );
  }
  h.failDisplay();
  await rejects(
    h.dispatch("push", { data: { json: () => h.payload } }),
    "PermissionRevoked",
  );
});

Deno.test("notification click focuses existing app without destroying drafts or following payload URLs", async () => {
  const h = await harness();
  /** @type {unknown[]} */
  const messages = [];
  let focused = 0;
  let closed = 0;
  h.windows.push({
    url: "https://evil.example/",
    postMessage() {
      throw new Error("WrongOrigin");
    },
    async focus() {
      throw new Error("WrongOrigin");
    },
  });
  h.windows.push({
    url: "https://app.example/",
    postMessage(value) {
      messages.push(value);
    },
    async focus() {
      focused++;
    },
  });
  await h.dispatch("notificationclick", {
    notification: {
      tag: "resonance-reminder:one",
      data: { url: "https://evil.example" },
      close() {
        closed++;
      },
    },
  });
  equal(closed, 1);
  equal(focused, 1);
  equal(messages, [{ type: "resonance-reminder-open" }]);
  equal(h.opened, []);
  await h.dispatch("notificationclick",{notification:{tag:"resonance-source:one",data:{url:"https://evil.example"},close(){}}});
  equal(messages.at(-1),{type:"resonance-source-update-open"});
  equal(focused,2);
  h.windows.length = 0;
  await h.dispatch("notificationclick", {
    notification: { tag: "resonance-reminder:one", close() {} },
  });
  equal(h.opened, ["https://app.example/?view=review"]);
  await h.dispatch("notificationclick", {
    notification: { tag: "other-app", close() {} },
  });
  equal(h.opened.length, 1);
  await h.dispatch("notificationclick",{notification:{tag:"resonance-source:one",close(){}}});
  equal(h.opened.at(-1),"https://app.example/?view=library");
});
