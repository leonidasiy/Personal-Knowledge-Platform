// Local browser acceptance: real production DOM/service worker, synthetic APIs
// and push subscriptions. Does not contact any push provider or learner account.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const origin = process.env.REMINDER_TEST_ORIGIN ?? "http://localhost:4320";
if (!["http://localhost:4320", "http://localhost:4321"].includes(origin)) {
  throw new Error("LocalTestOriginRequired");
}
const output = "output/playwright/reminders";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const failures = [], requests = [], remote = [];
let stored = null, unavailable = false, malformed = false;
const vapid = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const publicKey = Buffer.from(
  await crypto.subtle.exportKey("raw", vapid.publicKey),
).toString("base64url");
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 960 },
    permissions: ["notifications"],
    timezoneId: "Asia/Singapore",
  });
  await context.addInitScript(() => {
    window.reminderProbe = {
      permissionRequests: 0,
      subscribed: 0,
      unsubscribed: 0,
      deny: false,
    };
    const permission = Object.getOwnPropertyDescriptor(
      Notification,
      "permission",
    );
    Object.defineProperty(Notification, "permission", {
      get: () =>
        window.reminderProbe.deny
          ? "denied"
          : permission.get.call(Notification),
    });
    Notification.requestPermission = async () => {
      window.reminderProbe.permissionRequests++;
      return window.reminderProbe.deny ? "denied" : "granted";
    };
    const synthetic = {
      toJSON: () => ({
        endpoint: "https://fcm.googleapis.com/fcm/send/synthetic-browser-test",
        expirationTime: null,
        keys: { p256dh: "B" + "A".repeat(86), auth: "A".repeat(22) },
      }),
      unsubscribe: async () => {
        window.reminderProbe.unsubscribed++;
        return true;
      },
    };
    PushManager.prototype.subscribe = async function () {
      window.reminderProbe.subscribed++;
      return synthetic;
    };
    PushManager.prototype.getSubscription = async function () {
      return synthetic;
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("request", (request) => {
    if (!request.url().startsWith(origin)) remote.push(request.url());
  });
  await page.route("**/api/**", async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname === "/api/reminders") {
      if (unavailable) {
        return route.fulfill({
          status: 503,
          json: { error: "ReminderReadUnavailable" },
        });
      }
      if (malformed) {
        return route.fulfill({ json: { result: { enabled: true } } });
      }
      if (req.method() === "GET") {
        const deviceId = url.searchParams.get("deviceId");
        return route.fulfill({
          json: {
            result: stored ??
              {
                deviceId,
                enabled: false,
                time: "20:00",
                timeZone: null,
                skippedDate: null,
                lastStatus: null,
                publicKey,
              },
          },
        });
      }
      const body = req.postDataJSON();
      requests.push(body);
      if (body.action === "save") {
        assert.equal(typeof body.enabled, "boolean");
        assert.equal(body.timeZone, "Asia/Singapore");
        if (body.enabled) {
          assert.deepEqual(Object.keys(body.subscription).sort(), [
            "endpoint",
            "keys",
          ]);
        }
        stored = {
          deviceId: body.deviceId,
          enabled: body.enabled,
          time: body.time,
          timeZone: body.timeZone,
          skippedDate: null,
          lastStatus: body.enabled ? "enabled" : null,
          publicKey,
        };
      } else if (body.action === "skip") {
        stored = {
          ...stored,
          skippedDate: new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Singapore",
          }).format(new Date()),
          lastStatus: "skipped",
        };
      } else if (body.action === "test") {
        stored = { ...stored, lastStatus: "sent" };
      } else throw new Error("UnexpectedReminderAction");
      return route.fulfill({ json: { result: stored } });
    }
    if (url.pathname.endsWith("/feed-batch")) {
      return route.fulfill({ json: { result: { batch: null, items: [] } } });
    }
    if (url.pathname.endsWith("/review-batch")) {
      return route.fulfill({
        json: { result: { batch: null, questions: [], dueCount: 0 } },
      });
    }
    return route.fulfill({
      status: 503,
      json: { error: "SyntheticUnavailable" },
    });
  });
  await page.goto(origin);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#settings-title").waitFor();
  const form = page.locator("[data-reminder-form]");
  await form.getByRole("button", { name: "Save reminder", exact: true })
    .waitFor();
  await page.waitForFunction(() =>
    !document.querySelector('[name="time"]').disabled
  );
  assert.equal(
    await page.evaluate(() => window.reminderProbe.permissionRequests),
    0,
    "no prompt on page load",
  );
  await form.locator('[name="time"]').fill("21:15");
  await form.locator('[name="enabled"]').check();
  await page.locator('[data-setting="theme"][value="dark"]').check();
  assert.equal(
    await form.locator('[name="time"]').inputValue(),
    "21:15",
    "draft survives appearance change",
  );
  assert.equal(await form.locator('[name="enabled"]').isChecked(), true);
  await form.getByRole("button", { name: "Save reminder", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.querySelector("[data-reminder-status]")?.textContent?.includes(
      "selected time",
    )
  );
  assert.equal(stored.enabled, true);
  assert.equal(stored.time, "21:15");
  await form.getByRole("button", { name: "Test notification", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.querySelector("[data-reminder-status]")?.textContent?.includes(
      "test",
    )
  );
  assert.ok(requests.some((value) => value.action === "test"));
  await form.getByRole("button", { name: "Skip today", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector("[data-reminder-status]")?.textContent?.includes(
      "skipped",
    )
  );
  assert.ok(stored.skippedDate);
  for (const mode of ["light", "dark"]) {
    await page.locator(`[data-setting="theme"][value="${mode}"]`).check();
    await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, mode);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
    for (const width of [1280, 375, 320]) {
      await page.setViewportSize({ width, height: 960 });
      assert.ok(
        await page.evaluate(() =>
          document.documentElement.scrollWidth <= innerWidth + 1
        ),
        `${mode}/${width} overflow`,
      );
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: `${output}/${mode}-${width}.png`,
        fullPage: true,
      });
    }
  }
  await page.locator('[data-setting="motion"]').uncheck();
  await page.reload();
  await page.waitForFunction(() =>
    document.querySelector('[name="time"]')?.value === "21:15"
  );
  assert.equal(
    await page.locator('[data-setting="motion"]').isChecked(),
    false,
  );
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await form.locator('[name="enabled"]').uncheck();
  await form.getByRole("button", { name: "Save reminder", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.querySelector("[data-reminder-status]")?.textContent?.includes(
      "off on this device",
    )
  );
  assert.equal(stored.enabled, false);
  assert.equal(await page.evaluate(() => window.reminderProbe.unsubscribed), 1);
  await page.evaluate(() => {
    window.reminderProbe.deny = true;
  });
  await form.locator('[name="enabled"]').check();
  const before = requests.length;
  await form.getByRole("button", { name: "Save reminder", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.querySelector("[data-reminder-status]")?.textContent?.includes(
      "blocked",
    )
  );
  assert.equal(
    requests.length,
    before,
    "denied permission never enables backend",
  );
  for (const failure of ["unavailable", "malformed"]) {
    unavailable = failure === "unavailable";
    malformed = failure === "malformed";
    await page.reload();
    await page.getByRole("button", { name: /Retry|Try again/ }).waitFor();
    assert.ok(
      await page.locator('[data-setting="theme"][value="light"]').isEnabled(),
      "preferences remain available",
    );
    unavailable = false;
    malformed = false;
    await page.getByRole("button", { name: /Retry|Try again/ }).click();
    await page.waitForFunction(() =>
      !document.querySelector('[name="time"]').disabled
    );
  }
  await page.goto(origin + "/?view=review");
  await page.waitForFunction(() =>
    document.querySelector('.primary-nav [data-view="review"]')?.classList
      .contains("active")
  );
  // Chrome delivers a synthetic push through the real registered worker and
  // notification API. This is not a network push-provider/device delivery test.
  const cdp = await context.newCDPSession(page), registrations = [];
  cdp.on(
    "ServiceWorker.workerRegistrationUpdated",
    (event) => registrations.push(...event.registrations),
  );
  await cdp.send("ServiceWorker.enable");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.waitForTimeout(100);
  const registration = registrations.find((value) =>
    value.scopeURL === origin + "/"
  );
  assert.ok(registration, "real service worker registered");
  const deliver = (data) =>
    cdp.send("ServiceWorker.deliverPushMessage", {
      origin,
      registrationId: registration.registrationId,
      data: JSON.stringify(data),
    });
  const push = {
    type: "daily-reminder",
    id: "local-browser-reminder",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    test: true,
  };
  await deliver(push);
  await page.waitForFunction(async () => {
    const r = await navigator.serviceWorker.ready;
    return (await r.getNotifications()).some((n) =>
      n.tag === "resonance-reminder:local-browser-reminder"
    );
  });
  await deliver(push);
  await deliver({
    ...push,
    id: "expired",
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  await page.waitForTimeout(200);
  const notifications = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready;
    return (await r.getNotifications()).map((n) => ({
      title: n.title,
      body: n.body,
      tag: n.tag,
    }));
  });
  assert.deepEqual(notifications, [{
    title: "Resonance",
    body: "Your reminder is working. Tap to try your daily retrieval quiz.",
    tag: "resonance-reminder:local-browser-reminder",
  }]);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  // Synthetic clicks cannot grant OS activation for focus/openWindow. Assert
  // the real worker->app message routing; actual tray taps remain a phone gate.
  const worker = context.serviceWorkers()[0];
  const clickResult = await worker.evaluate(async () => {
    const notification = (await self.registration.getNotifications())[0];
    let completion;
    const event = new NotificationEvent("notificationclick", { notification });
    event.waitUntil = (promise) => {
      completion = promise;
    };
    self.dispatchEvent(event);
    try {
      await completion;
      return "focused";
    } catch (error) {
      return error.name;
    }
  });
  assert.ok(["focused", "InvalidAccessError"].includes(clickResult));
  await page.waitForFunction(() =>
    document.querySelector('.primary-nav [data-view="review"]')?.classList
      .contains("active")
  );
  assert.deepEqual(failures, []);
  assert.deepEqual(remote, []);
  console.log(
    "PASS: real browser Settings controls, save/test/skip/disable, permission denial, malformed/unavailable recovery, drafts, persistence, light/dark 320/375/1280px, startup and worker-message routing; real service-worker notification display, duplicate tag and expiry via CDP. Synthetic API/subscription/push transport; no Android delivery claim.",
  );
  await context.close();
} finally {
  await browser.close();
}
