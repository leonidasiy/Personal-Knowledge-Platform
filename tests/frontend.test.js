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

Deno.test("active learner owns Feed rendering while app retains local history contracts", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root)) + await Deno.readTextFile(new URL("src/routes/navigation.js", root));
  const learner = await readLearnerPresentation();
  assert(
    source.includes("if (learnerController !== null) return learnerController.renderFeed();") &&
      learner.includes("Preparing today's five knowledge cards") &&
      learner.includes("data-action=\"complete-learner-feed\""),
    "The active Feed must be rendered and controlled by the learner controller.",
  );
  assert(
    source.includes("dailyLearningRepository") &&
      source.includes("restoreLocalState") &&
      !source.includes("function renderFeedItem"),
    "Removing fixture Feed markup must not remove persisted local history restoration.",
  );
  assert(
    !/\b(?:XP|streak|daily plan|ranking score)\b/i.test(source),
    "Presentation source must not invent progress signals.",
  );
});

Deno.test("appearance is owner-scoped, exported, and erased; retired layouts remain storage-compatible", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root)) + await Deno.readTextFile(new URL("src/routes/navigation.js", root));
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
      !source.includes('data-setting="layout"') &&
      !source.includes('data-setting="${setting}"') &&
      source.includes('themeOption("light", "Fieldnotes")') &&
      source.includes('themeOption("dark", "Observatory")') &&
      !source.includes("<legend>Visual theme</legend>") &&
      !source.includes('<legend>Workspace layout</legend>') &&
      source.includes('data-setting="sound"'),
    "Settings must expose the showcase pair and sound, not the retired layout selector.",
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
      `${preset} must remain readable in existing persisted settings.`,
    );
  }
  assert(
    source.includes('visualTheme: /** @type {const} */ ("studio-signal")') &&
      source.includes('layoutMode: /** @type {const} */ ("split-desk")'),
    "The approved first-run theme and layout must remain explicit.",
  );
});

Deno.test("local Feed history retains its cursor lifetime and distinct errors", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root)) + await Deno.readTextFile(new URL("src/routes/navigation.js", root));
  assert(
    source.includes("cursorLifetimeMs: 24 * 60 * 60_000"),
    "The local cursor lifetime must be exactly 24 hours.",
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

Deno.test("active learner Feed completion has no legacy visibility tracker", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root)) + await Deno.readTextFile(new URL("src/routes/navigation.js", root));
  const learner = await readLearnerPresentation();
  assert(
    !source.includes("startStudyTracking") &&
      !source.includes("data-feed-reveal") &&
      !source.includes("passiveExposure"),
    "The retired Feed observer must not target learner cards or schedule legacy exposure writes.",
  );
  assert(
    learner.includes('data-action="complete-learner-feed"') &&
      learner.includes("When you’ve studied all five ideas, mark this batch studied to unlock its questions."),
    "The learner owns the explicit Feed completion transition.",
  );
});

Deno.test("theme changes preserve deliberate focus without legacy quiz handlers", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root)) + await Deno.readTextFile(new URL("src/routes/navigation.js", root));
  const experienceActions = await Deno.readTextFile(
    new URL("src/startup/experience-actions.js", root),
  );
  const styles = await Deno.readTextFile(new URL("src/styles.css", root));
  assert(!source.includes("features/questions/grading.js"), "The retired local quiz grader must not load from the app shell.");
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
  const source = await Deno.readTextFile(new URL("src/app.js", root)) + await Deno.readTextFile(new URL("src/routes/navigation.js", root));
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

Deno.test("showcase themes own composition and preserve motion preferences", async () => {
  const css = await Deno.readTextFile(new URL("src/styles.css", root));
  assert(
    css.includes(':root[data-theme="dark"]'),
    "A paired dark theme is required.",
  );
  assert(!css.includes("data-visual-theme"), "Retired presets must not override the selected pair.");
  for (const family of ["Fraunces", "Syne", "Manrope"]) {
    assert(css.includes(family), `${family} must be locally available.`);
  }
  assert(!css.includes("data-layout"), "Persisted legacy layouts must not override the showcase.");
  assert(
    css.includes(':root[data-theme="dark"] .app-layout') &&
      css.includes('.feed-stack { display: grid; grid-template-columns: minmax(0, 1fr)') &&
      css.includes('.daily-hero') && css.includes('.learner-feed-sentinel'),
    "Keep distinct showcase shells and hero while the approved refinement makes all Feed cards full-row.",
  );
  assert(
    css.includes("@media (prefers-reduced-motion: reduce)") &&
      css.includes("@media (forced-colors: active)"),
    "Reduced-motion and forced-color modes must remain explicit.",
  );
  const componentCss = css.slice(css.indexOf("* {"));
  assert(
    !/#[0-9a-f]{3,8}\b/i.test(componentCss),
    "Components must consume theme tokens instead of raw colors.",
  );
  assert(
    css.includes("--control-height: 44px"),
    "Interactive controls must use the approved minimum touch target.",
  );
});

Deno.test("all approved theme text tokens meet WCAG AA contrast", async () => {
  const css = await Deno.readTextFile(new URL("src/styles.css", root));
  const base = readSelectorPrimitives(css, ":root");
  const dark = {
    ...base,
    ...readSelectorPrimitives(css, ':root[data-theme="dark"]'),
  };
  for (
    const theme of [base, dark]
  ) {
    assertContrast(theme["studio-ink"], theme["studio-paper"], 4.5);
    assertContrast(theme["studio-ink-muted"], theme["studio-paper"], 4.5);
    assertContrast(theme["studio-coral"], theme["studio-paper"], 4.5);
    assertContrast(theme["studio-danger"], theme["studio-white"], 4.5);
    assertContrast(theme["studio-ink"], theme["studio-white"], 4.5);
    assertContrast(theme["studio-ink-muted"], theme["studio-white"], 4.5);
    assertContrast(theme["studio-ink"], theme["studio-teal-soft"], 4.5);
    assertContrast(theme["studio-focus"], theme["studio-paper"], 3);
    assertContrast(theme["studio-focus"], theme["studio-white"], 3);
  }
  for (const theme of [base]) {
    assertContrast(theme["studio-white"], theme["studio-teal"], 4.5);
  }
  for (const theme of [dark]) {
    assertContrast(theme["action-text"], theme["studio-teal"], 4.5);
  }
});

Deno.test("Feed and Review keep study and quiz controls exclusive", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root)) + await Deno.readTextFile(new URL("src/routes/navigation.js", root));
  const learner = await readLearnerPresentation();
  const libraryRoute = await readLibraryPresentation();
  assert(
    learner.includes("data-learner-feed-sentinel") &&
      learner.includes('data-action="complete-learner-feed"') &&
      learner.includes("Read all five, then mark this batch studied"),
    "Feed must expose the fixed five-card bottom-sentinel study transition.",
  );
  assert(
    learner.includes("data-learner-review") &&
      learner.includes('data-action="refresh-learner-review"') &&
      !learner.includes("Answer every question before refreshing") &&
      learner.includes("answerText") &&
      learner.includes('question.kind === "fill-blank"'),
    "Review must render questions, including fill-blank input, and allow unfinished batches to refresh.",
  );
  assert(
    !learner.includes("mark-studied") &&
      !learner.includes("renderQuiz("),
    "The learner surface must not expose the retired manual-study or feed-quiz controls.",
  );
  assert(
    libraryRoute.includes("Extracted knowledge points") &&
      libraryRoute.includes("data-library-knowledge-remove") &&
      !libraryRoute.includes("Review queue") &&
      !libraryRoute.includes("data-learning-review-decision"),
    "Library must show source knowledge management without a human approval queue.",
  );
  assert(
    source.includes("learnerController?.hasDueReview()") &&
      source.includes("nav-notification-dot"),
    "The top-level Review tab must expose its due-review notification.",
  );
});

Deno.test("Learner Review and Library terminate route failures independently", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root)) + await Deno.readTextFile(new URL("src/routes/navigation.js", root));
  const libraryRoute = await readLibraryPresentation();
  const libraryPage = await Deno.readTextFile(
    new URL("src/startup/library-page.js", root),
  );
  assert(
    source.includes("await loadLibraryRoute();") &&
      source.includes("learnerController.loadFeed(), learnerController.loadReview()") &&
      !source.includes('import("./routes/review.js")'),
    "Library and top-level Review must use their current controllers without reviving the retired Review route.",
  );
  const libraryLoader = source.slice(
    source.indexOf("async function loadLibraryRoute()"),
    source.indexOf("async function startFeedSession()"),
  );
  assert(
    libraryLoader.includes("if (libraryRouteLoad !== null)") &&
      libraryLoader.includes("await libraryRouteLoad;") &&
      libraryLoader.includes("if (libraryPageController !== null) return;"),
    "A repeated Library navigation must await a pending initial load while avoiding an unnecessary reload after completion.",
  );
  assert(
    source.includes('data-action="retry-route"') &&
      libraryPage.includes("listKnowledge") &&
      libraryPage.includes("data-library-knowledge-remove"),
    "Failed route loads and individual knowledge removal need explicit controls.",
  );
  assert(
    libraryRoute.includes("Browse saved sources, search extracted knowledge, and check processing status.") &&
      !libraryRoute.includes("Review queue needs attention"),
    "Library must distinguish source management from the top-level Review surface.",
  );
});

Deno.test("fatal local restore keeps export/reset recovery without legacy review replay", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root)) + await Deno.readTextFile(new URL("src/routes/navigation.js", root));
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
    source.includes("runLocalDataExport") &&
      !source.includes("createBrowserReviewRecovery") &&
      !source.includes("quarantine-reviews"),
    "Recovery must retain export/reset while omitting the unreachable legacy Review quarantine path.",
  );
});

Deno.test("Learner controls expose independent daily targets and batch ownership", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root)) + await Deno.readTextFile(new URL("src/routes/navigation.js", root));
  const libraryRoute = await readLibraryPresentation();
  const learner = await readLearnerPresentation();
  assert(
    source.includes("data-daily-settings-form") &&
      source.includes('min="1" max="50"') &&
      source.includes('name="daily-recall-limit" type="number" min="0" step="1"') &&
      source.includes("Independent daily goals: knowledge cards studied on Feed and quiz cards completed on Review."),
    "Settings must expose independent learning and review targets with their current input bounds.",
  );
  assert(
    !source.includes('import("./routes/review.js")') &&
      !source.includes("features/questions/grading.js"),
    "The app shell must not retain a second Review renderer or local grader.",
  );
  assert(
    learner.includes("data-action=\"complete-learner-feed\"") &&
      !source.includes("function renderFeedItem"),
    "The learner controller must own Feed completion without reviving fixture cards.",
  );
  assert(
    !libraryRoute.includes("Review queue") &&
      learner.includes("data-learner-feed-sentinel") &&
      learner.includes("Read all five, then mark this batch studied") &&
      learner.includes("Questions unlock after a Feed batch is studied"),
    "The Review tab must own paired questions and unlock them after Feed completion.",
  );
});

Deno.test("Discover remains a lazy destination with one bounded search command", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root)) + await Deno.readTextFile(new URL("src/routes/navigation.js", root));
  const discoveryPage = await Deno.readTextFile(
    new URL("src/startup/discovery-page.js", root),
  );
  assert(
    source.includes('navButton("discover", "Discover")') &&
      source.includes('view === "discover"') &&
      source.includes("location.hash = view") &&
      source.includes('section === "item"'),
    "Discover must be a selected, deep-linkable destination.",
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
    libraryNavigation.includes("libraryPageController?.revealSource(sourceId)"),
    "A Discover approval must reveal its source in an already-opened Library before navigation.",
  );
  assert(
    discoveryPage.includes("data-discovery-search-form") &&
      discoveryPage.includes('data-discovery-search-bound", "true"') &&
      discoveryPage.includes("centralGateway.capabilities()") &&
      discoveryPage.includes("centralGateway.search(command)") &&
      discoveryPage.includes('form.getAll("provider")') &&
      discoveryPage.includes("sourceLibrary.extract(") &&
      !discoveryPage.includes("sourceLibrary.reject(") &&
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

Deno.test("uncached Discover entry retries the hosted source capability probe", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root)) + await Deno.readTextFile(new URL("src/routes/navigation.js", root));
  const loadRoute = source.slice(
    source.indexOf("async function loadActiveRoute()"),
    source.indexOf("async function loadReviewRoute()"),
  );
  const discoveryBranch = loadRoute.slice(
    loadRoute.indexOf('if (view === "discover")'),
  );
  assert(
    discoveryBranch.includes('if (view === "discover")') &&
      discoveryBranch.includes("if (discoveryPage === null)") &&
      !discoveryBranch.includes(
        'activeView === "discover" && discoveryPage === null',
      ) &&
      discoveryBranch.includes("await discoveryPage.load()"),
    "Uncached Discover entries must retry load after one-time controller creation.",
  );
});

Deno.test("every project-owned CSS class is used or documented as dynamic", async () => {
  const css = await Deno.readTextFile(new URL("src/styles.css", root));
  /** @param {URL} directory @returns {Promise<string[]>} */
  async function readScripts(directory) {
    const sources = [];
    for await (const entry of Deno.readDir(directory)) {
      const path = new URL(entry.name + (entry.isDirectory ? "/" : ""), directory);
      if (entry.isDirectory) sources.push(...await readScripts(path));
      else if (entry.isFile && entry.name.endsWith(".js")) sources.push(await Deno.readTextFile(path));
    }
    return sources;
  }
  const application = [await Deno.readTextFile(new URL("index.html", root)), ...await readScripts(new URL("src/", root))].join("\n");
  const documentedDynamic = new Set([
    "signal-1",
    "signal-2",
    "signal-3",
    "is-correct",
    "is-incorrect",
    "is-review-required",
  ]);
  const classes = new Set(
    [...css.replace(/url\([^)]*\)/g, "").matchAll(/\.([a-z][\w-]*)/gi)].map((match) => match[1]),
  );
  for (const className of classes) {
    assert(
      application.includes(className) || documentedDynamic.has(className),
      `.${className} is neither used nor documented as a dynamic state.`,
    );
  }
});

Deno.test("notifications are dismissible, pausable, and semantically announced", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root)) + await Deno.readTextFile(new URL("src/routes/navigation.js", root));
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

Deno.test("app delegates Review answer feedback to the learner controller", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root)) + await Deno.readTextFile(new URL("src/routes/navigation.js", root));
  const learner = await Deno.readTextFile(
    new URL("src/features/learning-generation/learner.js", root),
  );
  assert(
    source.includes("learnerController.bind(root)") &&
      !source.includes("async function answerQuiz") &&
      learner.includes("gateway.answerReview"),
    "Only the learner controller may submit paired Review answers.",
  );
});

Deno.test("rerender paths preserve a deliberate focus target", async () => {
  const source = await Deno.readTextFile(new URL("src/app.js", root)) + await Deno.readTextFile(new URL("src/routes/navigation.js", root));
  const libraryRoute = await readLibraryPresentation();
  assert(
    source.includes("document.activeElement === preferred") &&
      source.includes("workspace instanceof HTMLElement"),
    "Failed focus restoration must fall back to the workspace instead of body.",
  );
  assert(
      source.includes("captureTransientViewState()") &&
      source.includes("restoreTransientViewState(panelState)") && source.includes("panelDrafts.get(activeView)") &&
      source.includes("DataTransfer") &&
      libraryRoute.includes('href="') && libraryRoute.includes('escapeHtml(`#upload?'),
    "Background rerenders must preserve existing transient state and Library must hand off uploads to their dedicated route.",
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

/** Read both parts of the Library presentation contract after shell extraction. */
async function readLibraryPresentation() {
  const html = await Deno.readTextFile(new URL("index.html", root));
  const data = html.match(/<script id="library-markup" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  if (!data) throw new Error("Library shell markup missing");
  return await Deno.readTextFile(new URL("src/routes/library.js", root)) + JSON.parse(data).flat().join("");
}

async function readLearnerPresentation() {
  const shell = await Deno.readTextFile(new URL("index.html", root));
  const data = shell.match(/<script id="feed-markup" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  if (!data) throw new Error("Feed shell markup missing");
  return await Deno.readTextFile(new URL("src/features/learning-generation/learner.js", root)) + JSON.parse(data).flat().join("");
}

Deno.test("Upload and header controls retain visible contrast without faded disabled text", async () => {
  const css = await Deno.readTextFile(new URL("src/styles.css", root));
  assert(css.includes('.upload-page [type="file"] { width: 100%; }'), "Native picker bounds do not depend on filename length.");
  const disabled = css.match(/^\.button:disabled\s*\{([^}]+)\}/m)?.[1] ?? "";
  assert(/(?:^|;)\s*color: var\(--text-muted\);/.test(disabled) && !disabled.includes("opacity:") && css.includes(".button:hover:not(:disabled), .button:disabled { border-color: var(--text-muted); background: var(--surface-subtle); }"), "Disabled controls keep readable text and visible boundary.");
  assert(css.lastIndexOf(".button:disabled {") > css.indexOf(".button.primary {"), "Disabled primary button uses disabled colors.");
  const checkbox = css.match(/\.upload-page \[type="checkbox"\]\s*\{([^}]+)\}/)?.[1] ?? "";
  assert(checkbox.includes("outline: 1px solid var(--text)"), "Unchecked native checkbox has a visible boundary.");
  const chip = css.match(/\.local-badge\s*\{([^}]+)\}/)?.[1] ?? "";
  assert(chip.includes("color: var(--text)") && chip.includes("border: 1px solid var(--text-muted)"), "Processing chip uses readable text and boundary tokens.");
  const base = readSelectorPrimitives(css, ":root");
  const dark = {...base, ...readSelectorPrimitives(css, ':root[data-theme="dark"]')};
  for (const theme of [base, dark]) {
    assertContrast(theme["studio-ink-muted"], theme["studio-mist"], 4.5);
    assertContrast(theme["studio-ink-muted"], theme["studio-paper"], 3);
    assertContrast(theme["studio-ink"], theme["studio-paper"], 4.5);
  }
});

Deno.test("Upload joins native-file and disclosure restoration through its source-bound form key", async () => {
  const app = await Deno.readTextFile(new URL("src/app.js", root));
  assert(app.includes('form.getAttribute("data-upload-form")'), "Generic transient restoration must recognize the Upload contract.");
  assert(app.includes("match.files = transfer.files") && app.includes("current.open = savedDetail.open"), "Native files and disclosure state use the established restoration path.");
});

Deno.test("card entrance keyframes require normal motion and the interface toggle", async () => {
  const css = await Deno.readTextFile(new URL("src/styles.css", root));
  const start = css.indexOf("@media (prefers-reduced-motion: no-preference)");
  const normal = css.slice(start, css.indexOf("@keyframes card-enter", start));
  const entrance = ':root:not([data-motion="off"]) .reveal-enter';
  assert(normal.includes(entrance + " { animation: card-enter 700ms"), "Entrance keyframes must be opt-in to normal motion, not shortened under reduced motion.");
  assert(!css.slice(0, start).includes("animation: card-enter"), "No unconditional entrance animation may hide a reduced-motion card before its first frame.");
});

Deno.test("native picker rotation and transition require normal motion and the interface toggle", async () => {
  const css = await Deno.readTextFile(new URL("src/styles.css", root));
  const start = css.indexOf("@media (prefers-reduced-motion: no-preference)");
  const normal = css.slice(start, css.indexOf("@keyframes card-enter", start));
  for (const rule of [':root:not([data-motion="off"]) select::picker-icon { transition: rotate 180ms; }', ':root:not([data-motion="off"]) select:open::picker-icon { rotate: 180deg; }']) {
    assert(normal.includes(rule), "Native picker motion must be confined to normal motion with the toggle on: " + rule);
  }
  assert(!css.slice(0, start).includes("transition: rotate") && !css.slice(0, start).includes("rotate: 180deg"), "No unconditional picker motion may escape the preference/toggle gate.");
});

Deno.test("desktop brand caption retains its word spacing when the line break is hidden", async () => {
  const source = await Deno.readTextFile(new URL("../src/app.js", import.meta.url));
  assert(source.includes("A place for <br>what stays."), "The caption must retain a space when its line break is hidden.");
});
