// @ts-check

import { FeedbackAudioService } from "../src/features/experience/audio.js";
import { SettingsRepository } from "../src/features/experience/settings.js";
import {
  accentSlotFor,
  applyPresentationUpdate,
  calculateShownProgress,
  countReviewsDue,
  createBoundedProgress,
  resolveTheme,
} from "../src/features/experience/presentation.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

class FakeStorage {
  /** @type {Map<string, string>} */
  values = new Map();
  failRead = false;
  failWrite = false;
  failErase = false;

  /** @param {string} key */
  getItem(key) {
    if (this.failRead) throw new Error("read");
    return this.values.get(key) ?? null;
  }

  /** @param {string} key @param {string} value */
  setItem(key, value) {
    if (this.failWrite) throw new Error("write");
    this.values.set(key, value);
  }

  /** @param {string} key */
  removeItem(key) {
    if (this.failErase) throw new Error("erase");
    this.values.delete(key);
  }
}

const defaultSettings = Object.freeze({
  schemaVersion: /** @type {const} */ (2),
  themeMode: /** @type {const} */ ("system"),
  visualTheme: /** @type {const} */ ("studio-signal"),
  layoutMode: /** @type {const} */ ("split-desk"),
  soundEnabled: false,
});

const visualThemes = Object.freeze([
  Object.freeze({
    id: /** @type {const} */ ("studio-signal"),
    label: "Studio Signal",
    source: "approved-test-contract",
  }),
  Object.freeze({
    id: /** @type {const} */ ("collection-index"),
    label: "Collection Index",
    source: "approved-test-contract",
  }),
  Object.freeze({
    id: /** @type {const} */ ("learning-pulse"),
    label: "Learning Pulse",
    source: "approved-test-contract",
  }),
]);

const layouts = Object.freeze([
  Object.freeze({
    id: /** @type {const} */ ("guided-stack"),
    label: "Guided Stack",
    source: "approved-test-contract",
  }),
  Object.freeze({
    id: /** @type {const} */ ("split-desk"),
    label: "Split Desk",
    source: "approved-test-contract",
  }),
  Object.freeze({
    id: /** @type {const} */ ("compact-index"),
    label: "Compact Index",
    source: "approved-test-contract",
  }),
]);

/** @param {FakeStorage} storage @param {string} [ownerId] */
function createSettingsRepository(storage, ownerId = "owner-a") {
  return new SettingsRepository({
    storage,
    key: "experience",
    ownerId,
    visualThemes,
    layouts,
    defaultVisualTheme: "studio-signal",
    defaultLayoutMode: "split-desk",
  });
}

Deno.test("settings remain missing until composition supplies defaults", () => {
  const repository = createSettingsRepository(new FakeStorage());
  const result = repository.load();
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "SettingsMissing");
});

Deno.test("settings save, reload, repeat, and erase within one owner", () => {
  const storage = new FakeStorage();
  const repository = createSettingsRepository(storage);
  assertEquals(repository.save(defaultSettings).ok, true);
  assertEquals(
    repository.save({
      ...defaultSettings,
      themeMode: "dark",
      visualTheme: "learning-pulse",
      layoutMode: "compact-index",
      soundEnabled: true,
    }).ok,
    true,
  );
  const loaded = repository.load();
  assertEquals(loaded.ok, true);
  if (loaded.ok) {
    assertEquals(loaded.value.themeMode, "dark");
    assertEquals(loaded.value.visualTheme, "learning-pulse");
    assertEquals(loaded.value.layoutMode, "compact-index");
    assertEquals(loaded.value.soundEnabled, true);
  }
  assertEquals(repository.erase().ok, true);
  assertEquals(repository.load().ok, false);
});

Deno.test("settings storage keys isolate two owners", () => {
  const storage = new FakeStorage();
  const ownerA = createSettingsRepository(storage, "owner-a");
  const ownerB = createSettingsRepository(storage, "owner-b");
  ownerA.save({ ...defaultSettings, themeMode: "light" });
  ownerB.save({ ...defaultSettings, themeMode: "dark", soundEnabled: true });
  const a = ownerA.load();
  const b = ownerB.load();
  if (a.ok) assertEquals(a.value.themeMode, "light");
  if (b.ok) assertEquals(b.value.themeMode, "dark");
  ownerA.erase();
  assertEquals(ownerA.load().ok, false);
  assertEquals(ownerB.load().ok, true);
});

Deno.test("settings report malformed, unsupported, and unavailable storage", () => {
  const storage = new FakeStorage();
  const repository = createSettingsRepository(storage);
  storage.values.set("experience:owner-a", "{");
  const malformed = repository.load();
  if (!malformed.ok) assertEquals(malformed.error.kind, "SettingsMalformed");
  storage.values.set(
    "experience:owner-a",
    JSON.stringify({
      ownerId: "owner-a",
      schemaVersion: 3,
      themeMode: "system",
      visualTheme: "studio-signal",
      layoutMode: "split-desk",
      soundEnabled: false,
    }),
  );
  const unsupported = repository.load();
  if (!unsupported.ok) {
    assertEquals(unsupported.error.kind, "SettingsVersionUnsupported");
  }
  storage.failRead = true;
  const read = repository.load();
  if (!read.ok) assertEquals(read.error.kind, "SettingsReadUnavailable");
  storage.failRead = false;
  storage.failWrite = true;
  const write = repository.save(defaultSettings);
  if (!write.ok) assertEquals(write.error.kind, "SettingsWriteUnavailable");
  storage.failErase = true;
  const erase = repository.erase();
  if (!erase.ok) assertEquals(erase.error.kind, "SettingsEraseUnavailable");
});

Deno.test("settings migrate valid v1 records to injected v2 defaults", () => {
  const storage = new FakeStorage();
  storage.values.set(
    "experience:owner-a",
    JSON.stringify({
      ownerId: "owner-a",
      schemaVersion: 1,
      themeMode: "dark",
      soundEnabled: true,
    }),
  );
  const repository = createSettingsRepository(storage);
  const migrated = repository.load();
  assertEquals(migrated.ok, true);
  if (migrated.ok) {
    assertEquals(migrated.value.schemaVersion, 2);
    assertEquals(migrated.value.themeMode, "dark");
    assertEquals(migrated.value.visualTheme, "studio-signal");
    assertEquals(migrated.value.layoutMode, "split-desk");
    assertEquals(migrated.value.soundEnabled, true);
  }
  const stored = JSON.parse(storage.values.get("experience:owner-a") ?? "{}");
  assertEquals(stored.schemaVersion, 2);
  assertEquals(stored.visualTheme, "studio-signal");
  assertEquals(stored.layoutMode, "split-desk");
});

Deno.test("settings name unknown presets and atomic migration failure", () => {
  const storage = new FakeStorage();
  const repository = createSettingsRepository(storage);
  const unknownTheme = repository.save({
    ...defaultSettings,
    visualTheme:
      /** @type {import("../src/features/experience/contracts.js").VisualTheme} */ ("unknown"),
  });
  assertEquals(unknownTheme.ok, false);
  if (!unknownTheme.ok) {
    assertEquals(unknownTheme.error.kind, "SettingsThemeUnknown");
  }
  const unknownLayout = repository.save({
    ...defaultSettings,
    layoutMode:
      /** @type {import("../src/features/experience/contracts.js").LayoutMode} */ ("unknown"),
  });
  assertEquals(unknownLayout.ok, false);
  if (!unknownLayout.ok) {
    assertEquals(unknownLayout.error.kind, "SettingsLayoutUnknown");
  }

  const legacy = JSON.stringify({
    ownerId: "owner-a",
    schemaVersion: 1,
    themeMode: "light",
    soundEnabled: false,
  });
  storage.values.set("experience:owner-a", legacy);
  storage.failWrite = true;
  const migration = repository.load();
  assertEquals(migration.ok, false);
  if (!migration.ok) {
    assertEquals(migration.error.kind, "SettingsMigrationFailed");
  }
  assertEquals(storage.values.get("experience:owner-a"), legacy);
});

/**
 * @param {{ state?: AudioContextState, failResume?: boolean, failPlayback?: boolean }} [options]
 */
function createAudioHarness(options = {}) {
  let starts = 0;
  let contexts = 0;
  const parameter = {
    /** @returns {typeof parameter} */ setValueAtTime() {
      return parameter;
    },
    /** @returns {typeof parameter} */ exponentialRampToValueAtTime() {
      return parameter;
    },
  };
  const context = {
    state: options.state ?? /** @type {const} */ ("running"),
    currentTime: 10,
    destination: {},
    async resume() {
      if (options.failResume) throw new Error("resume");
      context.state = "running";
    },
    createOscillator() {
      if (options.failPlayback) throw new Error("playback");
      return {
        frequency: parameter,
        type: /** @type {OscillatorType} */ ("sine"),
        /** @param {unknown} destination @returns {unknown} */ connect(
          destination,
        ) {
          return destination;
        },
        start() {
          starts += 1;
        },
        stop() {},
      };
    },
    createGain() {
      return {
        gain: parameter,
        /** @param {unknown} destination @returns {unknown} */ connect(
          destination,
        ) {
          return destination;
        },
      };
    },
  };
  return {
    context,
    createContext() {
      contexts += 1;
      return context;
    },
    get starts() {
      return starts;
    },
    get contexts() {
      return contexts;
    },
  };
}

const cue = Object.freeze({
  frequencyHz: 660,
  durationSeconds: 0.08,
  peakGain: 0.025,
  oscillatorType: /** @type {const} */ ("sine"),
});

Deno.test("audio stays uninitialized while disabled and requires activation", async () => {
  const harness = createAudioHarness();
  const service = new FeedbackAudioService({
    createContext: harness.createContext,
    cue,
  });
  const disabled = await service.playCue({
    enabled: false,
    explicitActivation: false,
  });
  assertEquals(disabled.ok, true);
  assertEquals(harness.contexts, 0);
  const blocked = await service.playCue({
    enabled: true,
    explicitActivation: false,
  });
  assertEquals(blocked.ok, false);
  if (!blocked.ok) assertEquals(blocked.error.kind, "AudioActivationRequired");
  assertEquals(harness.contexts, 0);
});

Deno.test("audio plays rapid cues through one activated context", async () => {
  const harness = createAudioHarness();
  const service = new FeedbackAudioService({
    createContext: harness.createContext,
    cue,
  });
  const results = await Promise.all([
    service.playCue({ enabled: true, explicitActivation: true }),
    service.playCue({ enabled: true, explicitActivation: true }),
  ]);
  assertEquals(
    results.every((
      /** @type {import("../src/features/experience/contracts.js").Result<import("../src/features/experience/contracts.js").AudioOutcome, import("../src/features/experience/contracts.js").AudioFailure>} */ result,
    ) => result.ok),
    true,
  );
  assertEquals(harness.contexts, 1);
  assertEquals(harness.starts, 2);
});

Deno.test("audio reports unsupported, resume, and playback failures", async () => {
  const unsupported = new FeedbackAudioService({ createContext: null, cue });
  const unavailable = await unsupported.playCue({
    enabled: true,
    explicitActivation: true,
  });
  if (!unavailable.ok) assertEquals(unavailable.error.kind, "AudioUnsupported");

  const suspended = createAudioHarness({
    state: "suspended",
    failResume: true,
  });
  const resume = await new FeedbackAudioService({
    createContext: suspended.createContext,
    cue,
  }).playCue({ enabled: true, explicitActivation: true });
  if (!resume.ok) assertEquals(resume.error.kind, "AudioResumeFailed");

  const broken = createAudioHarness({ failPlayback: true });
  const playback = await new FeedbackAudioService({
    createContext: broken.createContext,
    cue,
  }).playCue({ enabled: true, explicitActivation: true });
  if (!playback.ok) assertEquals(playback.error.kind, "AudioPlaybackFailed");

  const malformedFactory =
    /** @type {import("../src/features/experience/contracts.js").AudioContextFactory} */ (
      () => /** @type {import("../src/features/experience/contracts.js").AudioContextPort} */ ({})
    );
  const malformed = await new FeedbackAudioService({
    createContext: malformedFactory,
    cue,
  }).playCue({ enabled: true, explicitActivation: true });
  if (!malformed.ok) assertEquals(malformed.error.kind, "AudioUnsupported");
});

Deno.test("theme resolution follows explicit mode or injected system preference", () => {
  assertEquals(resolveTheme("system", true), "dark");
  assertEquals(resolveTheme("system", false), "light");
  assertEquals(resolveTheme("light", true), "light");
  assertEquals(resolveTheme("dark", false), "dark");
});

Deno.test("shown progress is unique, bounded, and factual", () => {
  const zero = calculateShownProgress([], []);
  if (zero.ok) assertEquals(zero.value.label, "0/0 studied");
  const partial = calculateShownProgress(["a", "b", "b", "c"], [
    "b",
    "b",
    "elsewhere",
  ]);
  if (partial.ok) {
    assertEquals(partial.value.studied, 1);
    assertEquals(partial.value.shown, 3);
    assertEquals(partial.value.ratio, 1 / 3);
  }
  const complete = createBoundedProgress(3, 3);
  if (complete.ok) assertEquals(complete.value.label, "3/3 studied");
  const invalid = createBoundedProgress(1.5, 2);
  if (!invalid.ok) assertEquals(invalid.error.kind, "ProgressInputInvalid");
  const outOfBounds = createBoundedProgress(3, 2);
  if (!outOfBounds.ok) {
    assertEquals(outOfBounds.error.kind, "ProgressOutOfBounds");
  }
});

Deno.test("due count uses the exact injected time boundary", () => {
  const candidates = [
    { candidateId: "before", dueAt: "2026-07-19T09:59:59.999Z" },
    { candidateId: "at", dueAt: "2026-07-19T10:00:00.000Z" },
    { candidateId: "at", dueAt: "2026-07-19T10:00:00.000Z" },
    { candidateId: "after", dueAt: "2026-07-19T10:00:00.001Z" },
    { candidateId: "new", dueAt: null },
  ];
  const before = countReviewsDue(candidates, "2026-07-19T09:59:59.998Z");
  const at = countReviewsDue(candidates, "2026-07-19T10:00:00.000Z");
  const after = countReviewsDue(candidates, "2026-07-19T10:00:00.001Z");
  if (before.ok) assertEquals(before.value, 0);
  if (at.ok) assertEquals(at.value, 2);
  if (after.ok) assertEquals(after.value, 3);
  const invalid = countReviewsDue(candidates, "not-a-time");
  if (!invalid.ok) assertEquals(invalid.error.kind, "ProgressInputInvalid");
});

Deno.test("accent slots are stable for arbitrary IDs and wrap to available slots", () => {
  const first = accentSlotFor("candidate/任何:id", 3);
  assertEquals(first, accentSlotFor("candidate/任何:id", 3));
  assertEquals(first >= 0 && first < 3, true);
  assertEquals(accentSlotFor("", 1), 0);
});

Deno.test("motion applies exactly once through transition and immediate fallback", async () => {
  let transitioned = 0;
  const success = await applyPresentationUpdate({
    update: () => {
      transitioned += 1;
    },
    transitions: {
      start(update) {
        update();
        return { finished: Promise.resolve() };
      },
    },
    reducedMotion: false,
  });
  assertEquals(success.kind, "TransitionApplied");
  assertEquals(transitioned, 1);

  let immediate = 0;
  const unavailable = await applyPresentationUpdate({
    update: () => {
      immediate += 1;
    },
    transitions: null,
    reducedMotion: false,
  });
  assertEquals(unavailable.kind, "TransitionFallbackApplied");
  assertEquals(immediate, 1);
});

Deno.test("motion start and completion failures never double apply updates", async () => {
  let startCount = 0;
  const startFailure = await applyPresentationUpdate({
    update: () => {
      startCount += 1;
    },
    transitions: {
      start(update) {
        update();
        throw new Error("start");
      },
    },
    reducedMotion: false,
  });
  assertEquals(startFailure.kind, "TransitionFallbackApplied");
  assertEquals(startCount, 1);

  let completionCount = 0;
  const completionFailure = await applyPresentationUpdate({
    update: () => {
      completionCount += 1;
    },
    transitions: {
      start(update) {
        update();
        return { finished: Promise.reject(new Error("finished")) };
      },
    },
    reducedMotion: false,
  });
  assertEquals(
    completionFailure.kind,
    "TransitionAppliedWithCompletionFailure",
  );
  assertEquals(completionCount, 1);

  let omittedCallbackCount = 0;
  const omittedCallback = await applyPresentationUpdate({
    update: () => {
      omittedCallbackCount += 1;
    },
    transitions: {
      start() {
        return { finished: Promise.resolve() };
      },
    },
    reducedMotion: false,
  });
  assertEquals(omittedCallback.kind, "TransitionApplied");
  assertEquals(omittedCallbackCount, 1);

  let reducedCount = 0;
  await applyPresentationUpdate({
    update: () => {
      reducedCount += 1;
    },
    transitions: {
      start() {
        throw new Error("must not run");
      },
    },
    reducedMotion: true,
  });
  assertEquals(reducedCount, 1);
});

Deno.test("motion observes every native transition promise", async () => {
  let applied = 0;
  const outcome = await applyPresentationUpdate({
    update: () => {
      applied += 1;
    },
    transitions: {
      start(update) {
        update();
        return {
          ready: Promise.reject(new DOMException("skipped", "AbortError")),
          updateCallbackDone: Promise.reject(
            new DOMException("skipped", "AbortError"),
          ),
          finished: Promise.resolve(),
        };
      },
    },
    reducedMotion: false,
  });
  await Promise.resolve();
  assertEquals(outcome.kind, "TransitionApplied");
  assertEquals(applied, 1);
});
