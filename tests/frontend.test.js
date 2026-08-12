// @ts-check

import { FeedService } from "../src/features/feed/service.js";

/** @import { FeedCandidate, FeedPolicy } from "../src/features/feed/contracts.js" */

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

const root = new URL("../", import.meta.url);

Deno.test("learning shell is local, theme-aware, and keyboard reachable", async () => {
  const html = await Deno.readTextFile(new URL("index.html", root));
  assert(
    html.includes('class="skip-link" href="#main-content"'),
    "The shell must expose a skip link to the rendered workspace.",
  );
  assert(
    html.includes('name="color-scheme" content="light dark"'),
    "The browser must know that both resolved themes are supported.",
  );
  assert(
    !/<(?:script|link)[^>]+(?:src|href)=["']https?:/i.test(html),
    "The application shell must not load remote runtime assets.",
  );
});

Deno.test("feed presentation uses assigned daily progress and responsive local media", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root));
  assert(
    source.includes("dailyLearningService.calculateProgress(") &&
      source.includes("<progress") &&
      source.includes("Daily studied") &&
      source.includes("assigned lessons studied today"),
    "Daily progress must come from fixed assignments and durable study facts.",
  );
  assert(
    source.includes("srcset=") &&
      source.includes("(max-width: 800px) 100vw") &&
      source.includes('loading="lazy"') &&
      source.includes('decoding="async"'),
    "Feed media must be responsive, dimensioned, lazy, and async-decoded.",
  );
  assert(
    !/\b(?:XP|streak|daily plan|ranking score)\b/i.test(source),
    "Presentation source must not invent progress signals.",
  );
});

Deno.test("theme and layout settings are dynamic, owner-scoped, exported, and erased", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root));
  const localDataActions = await Deno.readTextFile(
    new URL("src/startup/local-data-actions.js", root),
  );
  const html = await Deno.readTextFile(new URL("index.html", root));
  const presetMatch = html.match(
    /<script id="experience-presets" type="application\/json">([\s\S]*?)<\/script>/,
  );
  assert(
    presetMatch !== null,
    "The source-attributed preset registry is required.",
  );
  const presets = JSON.parse(presetMatch?.[1] ?? "{}");
  const presetSource = JSON.stringify(presets);
  assert(
    source.includes("new SettingsRepository({") &&
      source.includes("ownerId: LOCAL_OWNER_ID"),
    "Settings must receive the active owner explicitly.",
  );
  assert(
    source.includes('event.target.closest("button")') &&
      source.includes("void playInteractionCue()"),
    "Every enabled button must share the optional delegated click cue.",
  );
  assert(
    source.includes("experienceSettings,") &&
      localDataActions.includes("input.settings.erase()"),
    "Theme and sound settings must participate in export and erase.",
  );
  assert(
    source.includes(
      "Learning records were erased, but display settings could not be removed.",
    ) &&
      localDataActions.includes(
        "const settingsErased = input.settings.erase()",
      ) &&
      source.includes("location.reload();"),
    "A partial reset must report the settings failure and reload empty learning state.",
  );
  assert(
    source.includes('data-setting="theme"') &&
      source.includes('data-setting="${setting}"') &&
      source.includes('"visual-theme"') &&
      source.includes('"layout"') &&
      source.includes('data-setting="sound"'),
    "Settings must expose appearance, dynamic theme/layout, and sound controls.",
  );
  for (
    const preset of [
      "studio-signal",
      "collection-index",
      "learning-pulse",
      "guided-stack",
      "split-desk",
      "compact-index",
    ]
  ) {
    assert(
      presetSource.includes(`"${preset}"`),
      `${preset} must be selectable.`,
    );
  }
  assert(
    source.includes('visualTheme: /** @type {const} */ ("studio-signal")') &&
      source.includes('layoutMode: /** @type {const} */ ("split-desk")'),
    "The approved first-run theme and layout must remain explicit.",
  );
});

Deno.test("feed reveals immutable daily assignments and retains the 24-hour ranking policy", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root));
  assert(
    source.includes("cursorLifetimeMs: 24 * 60 * 60_000"),
    "The local cursor lifetime must be exactly 24 hours.",
  );
  assert(
    source.includes('data-feed-reveal') &&
      source.includes("revealedStudyItems += 1") &&
      source.includes("syncVisibleAssignment()") &&
      source.includes("if (!hasHiddenAssignedItems()) return;"),
    "The scroll boundary must reveal the frozen daily assignment without ranking again.",
  );
  assert(
    source.includes('rootMargin: "400px 0px"') &&
      source.includes("feedRevealObserver?.disconnect()") &&
      source.includes("void loadMore(false)") &&
      source.includes('data-action="load-more"'),
    "Automatic reveal needs a guarded observer and a manual capability fallback.",
  );
  assert(
    !source.slice(
      source.indexOf("async function loadMore"),
      source.indexOf("async function beginNewSession"),
    ).includes("feedService.getPage"),
    "Daily assignment reveal must not call the feed service.",
  );
  for (
    const failure of [
      "InvalidPageLimit",
      "CursorMalformed",
      "CursorOwnerMismatch",
      "CursorSessionMismatch",
      "FeedSessionMissing",
      "CandidateUnavailable",
    ]
  ) {
    assert(
      source.includes(`kind === "${failure}"`),
      `${failure} must keep a distinct user-facing branch.`,
    );
  }
});

Deno.test("feed reveal observer is single-use, independent, and capability-safe", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root));
  const start = source.slice(
    source.indexOf("function startStudyTracking()"),
    source.indexOf("/** @param {string} candidateId */", source.indexOf("function startStudyTracking()")),
  );
  class Button {
    hidden = true;
  }
  const fallback = new Button();
  const sentinel = { kind: "sentinel" };
  const card = { kind: "card" };
  /** @type {unknown[]} */
  const observed = [];
  const disconnected = [];
  /** @type {((entries: { isIntersecting: boolean, intersectionRatio: number, target: unknown }[]) => void)[]} */
  const callbacks = [];
  /** @type {unknown[]} */
  const options = [];
  class Observer {
    /** @param {(entries: { isIntersecting: boolean, intersectionRatio: number, target: unknown }[]) => void} callback @param {unknown} option */
    constructor(callback, option) {
      callbacks.push(callback);
      options.push(option);
    }
    /** @param {unknown} target */
    observe(target) {
      observed.push(target);
    }
    disconnect() {
      disconnected.push(true);
    }
  }
  /** @type {boolean[]} */
  const loadCalls = [];
  const createHarness = new Function(
    "activeView",
    "root",
    "globalThis",
    "HTMLButtonElement",
    "IntersectionObserver",
    "schedulePassiveExposure",
    "cancelPassiveExposure",
    "loadMore",
    "renderMessagesOnly",
    `let studyObserver = null; let feedRevealObserver = null; let notice = "";
    ${start}
    startStudyTracking();
    return {
      get notice() { return notice; },
      get studyObserver() { return studyObserver; },
      get feedRevealObserver() { return feedRevealObserver; },
      resetReveal() { feedRevealObserver?.disconnect(); feedRevealObserver = null; },
      startStudyTracking,
    };`,
  );
  const pageRoot = {
    /** @param {string} selector */
    querySelector(selector) {
      return selector.includes("load-more") ? fallback : sentinel;
    },
    querySelectorAll() {
      return [card];
    },
  };
  const result = createHarness(
    "feed",
    pageRoot,
    { IntersectionObserver: Observer },
    Button,
    Observer,
    () => {},
    () => {},
    /** @param {boolean} restoreFocus */
    async (restoreFocus) => loadCalls.push(restoreFocus),
    () => {},
  );
  assertEquals(callbacks.length, 2);
  assertEquals(observed[0], card);
  assertEquals(observed[1], sentinel);
  assertEquals(JSON.stringify(options[1]), JSON.stringify({ rootMargin: "400px 0px" }));
  assertEquals(fallback.hidden, true);
  result.resetReveal();
  result.startStudyTracking();
  callbacks[1]([{ isIntersecting: true, intersectionRatio: 1, target: sentinel }]);
  assertEquals(loadCalls.length, 0);
  callbacks[3]([{ isIntersecting: true, intersectionRatio: 1, target: sentinel }]);
  callbacks[3]([{ isIntersecting: true, intersectionRatio: 1, target: sentinel }]);
  assertEquals(JSON.stringify(loadCalls), JSON.stringify([false]));
  assertEquals(disconnected.length, 2);
  assert(result.studyObserver !== result.feedRevealObserver, "Passive and reveal observers must remain distinct.");

  let messages = 0;
  fallback.hidden = true;
  const unavailable = createHarness(
    "feed",
    pageRoot,
    {},
    Button,
    Observer,
    () => {},
    () => {},
    async () => {},
    () => messages += 1,
  );
  assertEquals(fallback.hidden, false);
  assertEquals(messages, 1);
  assertEquals(unavailable.notice, "Passive tracking is unavailable; manual study still works.");

  let constructions = 0;
  class RevealFailureObserver extends Observer {
    /** @param {(entries: { isIntersecting: boolean, intersectionRatio: number, target: unknown }[]) => void} callback @param {unknown} option */
    constructor(callback, option) {
      constructions += 1;
      if (constructions === 2) throw new Error("ObserverConstructionFailed");
      super(callback, option);
    }
  }
  fallback.hidden = true;
  createHarness(
    "feed",
    pageRoot,
    { IntersectionObserver: RevealFailureObserver },
    Button,
    RevealFailureObserver,
    () => {},
    () => {},
    async () => {},
    () => {},
  );
  assertEquals(fallback.hidden, false);
});

Deno.test("quiz writes are single-flight and theme changes preserve deliberate focus", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root));
  const experienceActions = await Deno.readTextFile(
    new URL("src/startup/experience-actions.js", root),
  );
  const styles = await Deno.readTextFile(new URL("src/styles.css", root));
  assert(
    source.includes("pendingWrites.has(pendingKey)") &&
      source.includes("pendingWrites.add(pendingKey)") &&
      source.includes('button[type="submit"]') &&
      source.includes("submitButton.disabled = true"),
    "Quiz submission state must survive rerenders and disable the active control.",
  );
  assert(
    experienceActions.includes("render(`theme-${mode}`, null)") &&
      !source.includes(
        'systemThemeQuery.addEventListener("change", () => {\n' +
          '    if (experienceSettings.themeMode !== "system") return;\n' +
          "    void applyPresentationUpdate({\n" +
          "      update: () => {\n" +
          "        applyExperiencePresentation();\n" +
          '        render("settings-summary", null);',
      ),
    "Intentional theme changes must refocus their radio and passive system changes must not rerender.",
  );
  assert(
    styles.includes(
      ".segmented-control input:checked + span {\n    outline: 2px solid CanvasText;",
    ),
    "Forced-colors mode must retain a visible selected-state indicator.",
  );
});

Deno.test("manual study remains single-flight until durable persistence completes", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root));
  const handler = source.slice(
    source.indexOf("async function recordManualStudy"),
    source.indexOf("async function recordPassiveExposure"),
  );
  assert(
    handler.includes("pendingWrites.has(idempotencyKey)") &&
      handler.includes("pendingWrites.add(idempotencyKey)") &&
      handler.includes('element.setAttribute("disabled", "")'),
    "Manual study state must survive rerenders and disable the active control.",
  );
  assert(
    handler.indexOf("await studyService.record(command)") <
      handler.indexOf("render("),
    "Study status may render only after the durable service call completes.",
  );
  assert(
    source.includes(
      "studied || pendingWrites.has(studyKey(candidate.id, 1))",
    ) &&
      source.includes("pendingWrites.has(`review:${prompt.id}`)"),
    "Replacement controls must remain disabled throughout pending writes.",
  );
});

Deno.test("24-hour cursor accepts one millisecond before and rejects the boundary", () => {
  /** @type {FeedPolicy} */
  const policy = {
    maxPageSize: 1,
    cursorLifetimeMs: 24 * 60 * 60_000,
    preferenceWeight: 0,
    exposurePenalty: 0,
    masteryPenalty: 0,
    dueBoost: 1,
    explorationFloor: 0.1,
    version: "cursor-boundary-test",
  };
  /** @type {readonly FeedCandidate[]} */
  const candidates = [
    {
      candidateId: "one",
      title: "One",
      knowledgeUnitIds: ["one"],
      eligible: true,
      signals: {
        preference: 0,
        qualifiedExposures: 0,
        mastery: null,
        dueAt: null,
      },
    },
    {
      candidateId: "two",
      title: "Two",
      knowledgeUnitIds: ["two"],
      eligible: true,
      signals: {
        preference: 0,
        qualifiedExposures: 0,
        mastery: null,
        dueAt: null,
      },
    },
  ];
  const service = new FeedService(
    candidates,
    policy,
    () => "boundary-session",
    () => true,
    () => ({ ok: true, value: true }),
  );
  const first = service.getPage({
    ownerId: "owner",
    limit: 1,
    now: "2026-07-19T00:00:00.000Z",
  });
  assert(
    first.ok && first.value.nextCursor !== null,
    "A continuation cursor is required.",
  );
  if (!first.ok || first.value.nextCursor === null) return;
  const before = service.getPage({
    ownerId: "owner",
    sessionId: first.value.sessionId,
    cursor: first.value.nextCursor,
    limit: 1,
    now: "2026-07-19T23:59:59.999Z",
  });
  assertEquals(before.ok, true);
  const boundary = service.getPage({
    ownerId: "owner",
    sessionId: first.value.sessionId,
    cursor: first.value.nextCursor,
    limit: 1,
    now: "2026-07-20T00:00:00.000Z",
  });
  assertEquals(boundary.ok, false);
  if (!boundary.ok) assertEquals(boundary.error.kind, "CursorExpired");
});

Deno.test("feed reports a candidate removed after session creation", () => {
  /** @type {FeedPolicy} */
  const policy = {
    maxPageSize: 1,
    cursorLifetimeMs: 60_000,
    preferenceWeight: 0,
    exposurePenalty: 0,
    masteryPenalty: 0,
    dueBoost: 1,
    explorationFloor: 0.1,
    version: "availability-test",
  };
  /** @type {readonly FeedCandidate[]} */
  const candidates = [
    {
      candidateId: "one",
      title: "One",
      knowledgeUnitIds: ["one"],
      eligible: true,
      signals: {
        preference: 0,
        qualifiedExposures: 0,
        mastery: null,
        dueAt: null,
      },
    },
    {
      candidateId: "two",
      title: "Two",
      knowledgeUnitIds: ["two"],
      eligible: true,
      signals: {
        preference: 0,
        qualifiedExposures: 0,
        mastery: null,
        dueAt: null,
      },
    },
  ];
  let available = true;
  const service = new FeedService(
    candidates,
    policy,
    () => "availability-session",
    () => available,
    () => ({ ok: true, value: true }),
  );
  const first = service.getPage({
    ownerId: "owner",
    limit: 1,
    now: "2026-07-19T00:00:00.000Z",
  });
  assert(
    first.ok && first.value.nextCursor !== null,
    "A continuation cursor is required.",
  );
  if (!first.ok || first.value.nextCursor === null) return;
  available = false;
  const removed = service.getPage({
    ownerId: "owner",
    sessionId: first.value.sessionId,
    cursor: first.value.nextCursor,
    limit: 1,
    now: "2026-07-19T00:00:01.000Z",
  });
  assertEquals(removed.ok, false);
  if (!removed.ok) assertEquals(removed.error.kind, "CandidateUnavailable");
});

Deno.test("all themes and layouts consume independent tokens and preserve motion preferences", async () => {
  const css = await Deno.readTextFile(new URL("src/styles.css", root));
  assert(
    css.includes(':root[data-theme="dark"]'),
    "A paired dark theme is required.",
  );
  for (
    const theme of [
      "collection-index",
      "learning-pulse",
    ]
  ) {
    assert(
      css.includes(`:root[data-visual-theme="${theme}"]`) &&
        css.includes(
          `:root[data-visual-theme="${theme}"][data-theme="dark"]`,
        ),
      `${theme} must define paired token overrides.`,
    );
  }
  for (
    const layout of ["guided-stack", "split-desk", "compact-index"]
  ) {
    assert(
      layout === "split-desk" ||
        css.includes(`.workspace[data-layout="${layout}"]`),
      `${layout} must be available through the layout axis.`,
    );
  }
  assert(
    !/\[data-visual-theme=[^\]]+\][^{,]*\[data-layout=/i.test(css),
    "Theme and layout selectors must not be coupled.",
  );
  assert(
    css.includes(".learning-card.signal-1") &&
      css.includes(".learning-card.signal-2") &&
      css.includes(".learning-card.signal-3"),
    "All approved decorative signal slots must exist.",
  );
  assert(
    css.includes("@media (prefers-reduced-motion: reduce)") &&
      css.includes("@media (forced-colors: active)"),
    "Reduced-motion and forced-color modes must remain explicit.",
  );
  const componentCss = css.slice(css.indexOf("* {"));
  assert(
    !/#[0-9a-f]{3,8}\b/i.test(componentCss),
    "Components must consume Studio Signal tokens instead of raw colors.",
  );
  assert(
    css.includes("--control-height: 44px"),
    "Interactive controls must use the approved minimum touch target.",
  );
});

Deno.test("all approved theme text tokens meet WCAG AA contrast", async () => {
  const css = await Deno.readTextFile(new URL("src/styles.css", root));
  const base = readSelectorPrimitives(css, ":root");
  const collection = {
    ...base,
    ...readSelectorPrimitives(
      css,
      ':root[data-visual-theme="collection-index"]',
    ),
  };
  const pulse = {
    ...base,
    ...readSelectorPrimitives(
      css,
      ':root[data-visual-theme="learning-pulse"]',
    ),
  };
  const dark = {
    ...base,
    ...readSelectorPrimitives(css, ':root[data-theme="dark"]'),
  };
  const collectionDark = {
    ...collection,
    ...dark,
    ...readSelectorPrimitives(
      css,
      ':root[data-visual-theme="collection-index"][data-theme="dark"]',
    ),
  };
  const pulseDark = {
    ...pulse,
    ...dark,
    ...readSelectorPrimitives(
      css,
      ':root[data-visual-theme="learning-pulse"][data-theme="dark"]',
    ),
  };
  for (
    const theme of [base, collection, pulse, dark, collectionDark, pulseDark]
  ) {
    assertContrast(theme["studio-ink"], theme["studio-paper"], 4.5);
    assertContrast(theme["studio-ink-muted"], theme["studio-paper"], 4.5);
    assertContrast(theme["studio-coral"], theme["studio-paper"], 4.5);
    assertContrast(theme["studio-danger"], theme["studio-white"], 4.5);
  }
  for (const theme of [base, collection, pulse]) {
    assertContrast(theme["studio-white"], theme["studio-teal"], 4.5);
  }
  for (const theme of [dark, collectionDark, pulseDark]) {
    assertContrast(theme["action-text"], theme["studio-teal"], 4.5);
  }
});

Deno.test("Feed and Review keep study and quiz controls exclusive", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root));
  const reviewRoute = await Deno.readTextFile(
    new URL("src/routes/review.js", root),
  );
  const libraryRoute = await Deno.readTextFile(
    new URL("src/routes/library.js", root),
  );
  const feedStart = source.indexOf("function renderFeedItem");
  const quizStart = source.indexOf("function renderQuiz", feedStart);
  const reviewStart = source.indexOf("function renderReviewView", quizStart);
  const libraryStart = source.indexOf(
    "function renderLibraryView",
    reviewStart,
  );
  const feed = source.slice(feedStart, quizStart);
  const review = reviewRoute;
  assert(
    feed.includes('data-action="mark-studied"'),
    "Feed must expose manual study.",
  );
  assert(!feed.includes("renderQuiz("), "Feed must not render a quiz.");
  assert(
    review.includes("data-review-answer") &&
      review.includes("renderCurrentQuestion("),
    "Review must render one active question through its lazy route.",
  );
  assert(
    !review.includes("mark-studied"),
    "Review must not render study controls.",
  );
  assert(
    !source.includes("Mark studied ("),
    "Study controls must not contain countdown text.",
  );
  assert(
    source.includes('kind: "manual_study"') &&
      source.includes("studyRepository.list(LOCAL_OWNER_ID"),
    "Manual study must be durable and drive factual progress.",
  );
  assert(
    libraryRoute.includes("Search saved sources") &&
      libraryRoute.includes("Review queue") &&
      !libraryRoute.includes("mark-studied"),
    "Library must separate source management from study and recall controls.",
  );
});

Deno.test("Review and Library terminate route failures and isolate recall recovery", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root));
  const libraryRoute = await Deno.readTextFile(
    new URL("src/routes/library.js", root),
  );
  const reviewRecovery = await Deno.readTextFile(
    new URL("src/startup/review-recovery.js", root),
  );
  assert(
    source.includes("await loadLibraryRoute();") &&
      source.includes('libraryPage === "review-queue"') &&
      source.includes("await ensureRecallRuntime();"),
    "The source catalog must load without recall while the queue initializes recall explicitly.",
  );
  assert(
    source.includes('data-action="retry-route"') &&
      source.includes('data-action="quarantine-reviews"') &&
      source.includes("runLocalDataExport") &&
      source.includes("Export and continue") &&
      reviewRecovery.includes(
        'dependencies.location.hash = "library/review-queue"',
      ) &&
      reviewRecovery.includes("dependencies.location.reload();"),
    "Failed route loads and incompatible review history need explicit recovery controls.",
  );
  assert(
    libraryRoute.includes("Your source catalog remains available") &&
      libraryRoute.includes("Review queue needs attention"),
    "Library must distinguish collection access from recall-derived status.",
  );
});

Deno.test("every fatal local restore outcome replaces route opening placeholders with recovery", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root));
  assert(
    source.includes(
      "startupRestoreIssue = restoreRecoveryFor(restored.error)",
    ) &&
      source.includes('failure.kind === "LocalStateReadFailed"') &&
      source.includes('kind: "LocalStateReadFailed" | "LocalStateCorrupt"'),
    "Read and corrupt restore failures must map to an explicit terminal state.",
  );
  assert(
    source.includes(
      "startupRestoreIssue !== null\n        ? renderStartupRecovery()",
    ) && source.includes("if (startupRestoreIssue !== null) return;"),
    "Fatal restore recovery must render before route content and block lazy route loading.",
  );
  assert(
    source.includes('id="restore-title"') &&
      source.includes('data-action="export"') &&
      source.includes('data-action="reset"') &&
      source.includes("Your saved answers have not been changed."),
    "Fatal recovery must be non-technical and offer backup and reset actions.",
  );
  assert(
    source.includes("reason: replayed.error.kind") &&
      source.includes("recallSourceRecords.get(command.idempotencyKey)"),
    "Replay failures must preserve their named reason and exact source record for targeted quarantine.",
  );
});

Deno.test("Milestone 2C controls expose approved targets, question variety, and queue ownership", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root));
  const reviewRoute = await Deno.readTextFile(
    new URL("src/routes/review.js", root),
  );
  const libraryRoute = await Deno.readTextFile(
    new URL("src/routes/library.js", root),
  );
  assert(
    source.includes("data-daily-settings-form") &&
      source.includes('min="1" max="50"') &&
      source.includes("Recall limit must be lower than the study target.") &&
      source.includes("Changes apply to the next assigned set."),
    "Daily learning settings must expose the approved atomic target pair.",
  );
  for (
    const kind of [
      "single-choice",
      "multiple-choice",
      "fill-blank",
      "free-response",
      "case-study",
    ]
  ) {
    assert(
      reviewRoute.includes(`"${kind}"`),
      `${kind} must have an accessible Review rendering path.`,
    );
  }
  assert(
    source.includes("10 * 60_000") &&
      source.includes("Recall ready after") &&
      !source.includes("Mark studied ("),
    "Prompt availability must use a static ten-minute timestamp without countdown controls.",
  );
  assert(
    !reviewRoute.includes("Review queue") &&
      libraryRoute.includes("Review queue") &&
      libraryRoute.includes('href="#library/review-queue"') &&
      source.includes('section === "scheduled"') &&
      source.includes("resolveScheduledReview") &&
      source.includes("This scheduled prompt is no longer available.") &&
      source.includes("This prompt has not entered scheduled review.") &&
      source.includes("This prompt is next due"),
    "The scheduled queue must belong to the Library route.",
  );
  assert(
    source.includes("promptRuntime.generateDue(studied)") &&
      source.includes("generation.value.prompts") &&
      source.includes("const generatedPrompts = promptRuntime.listPrompts") &&
      !source.includes("generatedPromptIds"),
    "Daily recall must draw from the persisted learned prompt bank.",
  );
  assert(
    source.includes(
      "fact.learningDay >= sevenDayCutoff && fact.learningDay <= day",
    ),
    "Seven-day recall accuracy must exclude future learning-day records.",
  );
});

Deno.test("Discover is a lazy fourth destination with one bounded search command", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root));
  const discoveryPage = await Deno.readTextFile(
    new URL("src/startup/discovery-page.js", root),
  );
  assert(
    source.includes('navButton("discover", "Discover")') &&
      source.includes('view === "discover"') &&
      source.includes("location.hash = view") &&
      source.includes('section === "item"'),
    "Discover must be a selected, deep-linkable fourth destination.",
  );
  const navigationHandler = source.slice(
    source.indexOf('root.querySelectorAll("[data-view]")'),
    source.indexOf(
      'if (activeView === "discover")',
      source.indexOf('root.querySelectorAll("[data-view]")'),
    ),
  );
  assert(
    navigationHandler.includes("location.hash = view;") &&
      !navigationHandler.includes("loadActiveRoute") &&
      !navigationHandler.includes("renderWithTransition"),
    "Navigation clicks must delegate one route load and transition to hashchange.",
  );
  assert(
    /import\(\s*["']\.\/startup\/discovery-page\.js["']\s*\)/.test(
      source,
    ) && !/^import .*discovery-page/m.test(source),
    "Discover page code must stay behind route activation.",
  );
  const libraryNavigation = source.slice(
    source.indexOf("navigateToLibrary:"),
    source.indexOf("rerender:", source.indexOf("navigateToLibrary:")),
  );
  assert(
    libraryNavigation.includes("libraryPageController?.load()"),
    "A Discover approval must refresh an already-opened Library before navigation.",
  );
  assert(
    discoveryPage.includes("data-discovery-search-form") &&
      discoveryPage.includes('data-discovery-search-bound", "true"') &&
      discoveryPage.includes("centralGateway.capabilities()") &&
      discoveryPage.includes("centralGateway.search(command)") &&
      discoveryPage.includes('form.getAll("provider")') &&
      discoveryPage.includes("sourceLibrary.approve(") &&
      discoveryPage.includes("sourceLibrary.reject(") &&
      discoveryPage.includes("sourceLibrary.suppressed(") &&
      !discoveryPage.includes("data-discovery-rss-form") &&
      !discoveryPage.includes("data-discovery-youtube-form"),
    "Discover must call the centralized gateway and preserve bounded Library decisions.",
  );
  assert(
    !discoveryPage.includes("discovery-evidence-actions") &&
      !discoveryPage.includes("data-discovery-evidence-form") &&
      !discoveryPage.includes("data-discovery-triage"),
    "Retired item-level evidence and inbox actions must not remain active.",
  );
  for (
    const prohibited of [
      "discoveryRuntime.markStudied",
      "discoveryRuntime.answer",
      "discoveryRuntime.createQuiz",
      "discoveryRuntime.downloadYouTube",
    ]
  ) {
    assert(
      !discoveryPage.includes(prohibited),
      prohibited + " must not exist.",
    );
  }
});

Deno.test("Discover route re-entry retries the hosted source capability probe", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root));
  const loadRoute = source.slice(
    source.indexOf("async function loadActiveRoute()"),
    source.indexOf("async function loadReviewRoute()"),
  );
  const discoveryBranch = loadRoute.slice(
    loadRoute.indexOf('if (activeView === "discover")'),
  );
  assert(
    discoveryBranch.includes('if (activeView === "discover")') &&
      discoveryBranch.includes("if (discoveryPage === null)") &&
      !discoveryBranch.includes(
        'activeView === "discover" && discoveryPage === null',
      ) &&
      discoveryBranch.includes("await discoveryPage.load()"),
    "Every Discover entry must retry load after one-time controller creation.",
  );
});

Deno.test("every project-owned CSS class is used or documented as dynamic", async () => {
  const css = await Deno.readTextFile(new URL("src/styles.css", root));
  const application = [
    await Deno.readTextFile(new URL("src/app.js", root)),
    await Deno.readTextFile(
      new URL("src/features/notifications/controller.js", root),
    ),
    await Deno.readTextFile(new URL("src/routes/review.js", root)),
    await Deno.readTextFile(new URL("src/routes/library.js", root)),
    await Deno.readTextFile(new URL("src/routes/discover.js", root)),
    await Deno.readTextFile(new URL("index.html", root)),
  ].join("\n");
  const documentedDynamic = new Set([
    "signal-1",
    "signal-2",
    "signal-3",
    "is-correct",
    "is-incorrect",
    "is-review-required",
  ]);
  const classes = new Set(
    [...css.matchAll(/\.([a-z][\w-]*)/gi)].map((match) => match[1]),
  );
  for (const className of classes) {
    assert(
      application.includes(className) || documentedDynamic.has(className),
      `.${className} is neither used nor documented as a dynamic state.`,
    );
  }
});

Deno.test("notifications are dismissible, pausable, and semantically announced", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root));
  const notificationSource = await Deno.readTextFile(
    new URL("src/features/notifications/controller.js", root),
  );
  const css = await Deno.readTextFile(new URL("src/styles.css", root));
  assert(
    source.includes("durationMs: 4_000") &&
      notificationSource.includes('event.key === "Escape"') &&
      notificationSource.includes('["pointerover", true]') &&
      notificationSource.includes('["focusout", false]'),
    "Notifications must auto-dismiss, pause, resume, and support Escape.",
  );
  assert(
    notificationSource.includes('aria-label="Close notification"') &&
      notificationSource.includes(
        'notification.kind === "error" ? "alert" : "status"',
      ),
    "Notifications need a labeled close action and kind-specific live semantics.",
  );
  assert(
    css.includes("grid-template-columns: minmax(0, 1fr) 44px") &&
      css.includes("pointer-events: auto") &&
      css.includes(".toast-close:focus-visible"),
    "The close action must remain reachable and visibly focused.",
  );
});

Deno.test("correct feedback animation is gated by persisted answer state", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root));
  const answerHandler = source.slice(
    source.indexOf("async function answerQuiz"),
    source.indexOf("async function persistFinalizedRecall"),
  );
  const persistenceIndex = answerHandler.indexOf(
    "await persistFinalizedRecall",
  );
  const feedbackIndex = answerHandler.lastIndexOf(
    "answerFeedbackByPrompt.set(promptId",
  );
  const cueIndex = answerHandler.indexOf("void playAnswerCue(");
  assert(
    persistenceIndex >= 0,
    "The durable finalized-recall boundary must exist.",
  );
  assert(
    feedbackIndex > persistenceIndex && cueIndex > persistenceIndex,
    "Animation state and audio may be created only after durable persistence.",
  );
  assertEquals(
    source.includes('answerFeedback.animate ? " animate-confirmation"'),
    true,
  );
});

Deno.test("rerender and dismissal paths preserve a deliberate focus target", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root));
  assert(
    source.includes("focusLessonHeading(candidateId);"),
    "Not-now dismissal must move focus before reporting its status.",
  );
  assert(
    source.includes('render(`card-heading:${candidateId}`, "feed-title")'),
    "A newly disabled studied control must move focus to its lesson heading.",
  );
  assert(
    source.includes("document.activeElement === preferred") &&
      source.includes("workspace instanceof HTMLElement"),
    "Failed focus restoration must fall back to the workspace instead of body.",
  );
});

/** @param {string} source @param {string} selector @returns {Record<string, string>} */
function readSelectorPrimitives(source, selector) {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing selector ${selector}.`);
  const end = source.indexOf("}", start);
  if (end < 0) throw new Error(`Unclosed selector ${selector}.`);
  return Object.fromEntries(
    [...source.slice(start, end).matchAll(/--([\w-]+):\s*(#[0-9a-f]{6,8});/gi)]
      .map((match) => [
        match[1],
        match[2],
      ]),
  );
}

/** @param {string} foreground @param {string} background @param {number} minimum */
function assertContrast(foreground, background, minimum) {
  const ratio = contrastRatio(foreground, background);
  assert(
    ratio >= minimum,
    `${foreground} on ${background} has contrast ${
      ratio.toFixed(2)
    }, below ${minimum}.`,
  );
}

/** @param {string} foreground @param {string} background */
function contrastRatio(foreground, background) {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

/** @param {string} value */
function luminance(value) {
  const channels = value.slice(1, 7).match(/.{2}/g);
  if (channels === null) throw new TypeError("Expected a six-digit hex color.");
  const [red, green, blue] = channels.map((channel) => {
    const component = Number.parseInt(channel, 16) / 255;
    return component <= 0.04045
      ? component / 12.92
      : ((component + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
