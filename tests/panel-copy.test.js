// @ts-check
import { createSettingsPage } from "../src/features/reminders/page.js";
import { createReminderClient } from "../src/features/reminders/client.js";
import { createProgressPage } from "../src/features/progress/page.js";
/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
Deno.test("Settings and reminder panels describe device preferences and notifications", () => {
  const client = createReminderClient({
    ownerId: "sample",
    fetch: async () => {
      throw new Error("No requests expected");
    },
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    navigator: { onLine: true },
  });
  const html = createSettingsPage({
    client,
    renderPreferences: () => "",
    onChange: () => {},
  }).render();
  for (
    const text of [
      '<h1 id="settings-title">Settings</h1>',
      "Adjust appearance, motion, sound, and notifications on this device.",
      "Review reminders and source updates",
      "Enable notifications on this device and choose a daily review reminder time.",
    ]
  ) assert(html.includes(text), `Missing approved copy: ${text}`);
});
Deno.test("Progress describes recorded activity for the selected period", () => {
  const html = createProgressPage({
    fetch: async () => {
      throw new Error("No requests expected");
    },
    baseUrl: "https://example.test/",
    escapeHtml: (value) => value,
    onChange: () => {},
  }).render();
  assert(
    html.includes(
      "View review accuracy, scores, and recorded activity for the selected period.",
    ),
    "Progress purpose must be explicit before loading.",
  );
});
Deno.test("Progress observations use descriptive section headings", async () => {
  const { buildProgress } = await import("../src/features/progress/public.js");
  const summary = buildProgress({
    days: 7,
    now: "2026-10-03T00:00:00.000Z",
    subject: null,
    attempts: [],
    studies: [],
  });
  if (!summary.ok) throw new Error("Invalid fixture");
  const page = createProgressPage({
    fetch: async () => Response.json({ result: summary.value }),
    baseUrl: "https://app.example/",
    escapeHtml: (value) => value,
    onChange: () => {},
  });
  await page.load();
  assert(
    !page.render().includes("Your rhythm, not a streak.") &&
      !page.render().includes("Correction that lasts."),
    "Replace vague observations without deleting factual measurement instructions.",
  );
  assert(
    page.render().includes("at least one elapsed day") &&
      page.render().includes("Activity records are not mastery or transfer."),
    "Factual measurement boundaries remain.",
  );
});
