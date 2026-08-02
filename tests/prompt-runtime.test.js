// @ts-check

import { catalogFixtures } from "../src/features/catalog/fixture.js";
import { FixturePromptRuntime } from "../src/features/prompt-bank/fixture-runtime.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

function setup(initialNow = "2026-07-20T00:09:59.999Z") {
  let now = initialNow;
  /** @type {import("../src/features/prompt-bank/contracts.js").PromptGenerationEvent[]} */
  const events = [];
  const runtime = new FixturePromptRuntime({
    candidates: catalogFixtures,
    ownerId: "owner-a",
    now: () => now,
    write: (event) => {
      events.push(event);
      return Promise.resolve({
        ok: true,
        value: /** @type {const} */ (true),
      });
    },
  });
  /** @param {string} value */
  function setNow(value) {
    now = value;
  }
  return {
    runtime,
    events,
    setNow,
  };
}

Deno.test("fixture runtime respects each material's own inclusive ten-minute boundary", async () => {
  const context = setup();
  const first = catalogFixtures[0];
  const second = catalogFixtures[1];
  const studied = [
    { candidate: first, studiedAt: "2026-07-20T00:00:00.000Z" },
    { candidate: second, studiedAt: "2026-07-20T00:05:00.000Z" },
  ];
  const early = await context.runtime.generateDue(studied);
  if (!early.ok) throw new Error(early.error.kind);
  assertEquals(early.value.prompts.length, 0);
  assertEquals(early.value.nextEligibleAt, "2026-07-20T00:10:00.000Z");

  context.setNow("2026-07-20T00:10:00.000Z");
  const firstDue = await context.runtime.generateDue(studied);
  if (!firstDue.ok) throw new Error(firstDue.error.kind);
  assertEquals(firstDue.value.prompts.length, 1);
  assertEquals(firstDue.value.prompts[0].contentId, first.id);
  assertEquals(firstDue.value.nextEligibleAt, "2026-07-20T00:15:00.000Z");

  context.setNow("2026-07-20T00:15:00.000Z");
  const allDue = await context.runtime.generateDue(studied);
  if (!allDue.ok) throw new Error(allDue.error.kind);
  assertEquals(allDue.value.prompts.length, 2);
  assertEquals(context.events.length, 2);
});

Deno.test("persisted prompt events restore the learned prompt bank", async () => {
  const context = setup("2026-07-20T00:10:00.000Z");
  const candidate = catalogFixtures[0];
  await context.runtime.generateDue([
    { candidate, studiedAt: "2026-07-20T00:00:00.000Z" },
  ]);
  const restored = setup("2026-07-20T00:10:00.000Z");
  assertEquals(restored.runtime.restore(context.events[0]).ok, true);
  assertEquals(restored.runtime.listPrompts("owner-a").length, 1);
});
