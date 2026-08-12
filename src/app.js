// @ts-check

import { CatalogRepository } from "./features/catalog/repository.js";
import { ExposureRepository } from "./features/exposure/repository.js";
import { ExposureService } from "./features/exposure/service.js";
import { FeedbackAudioService } from "./features/experience/audio.js";
import {
  accentSlotFor,
  applyPresentationUpdate,
  resolveTheme,
} from "./features/experience/presentation.js";
import { SettingsRepository } from "./features/experience/settings.js";
import { PreferenceRepository } from "./features/preference/repository.js";
import { PreferenceService } from "./features/preference/service.js";
import { RecallRepository } from "./features/recall/repository.js";
import { StudyRepository } from "./features/study/repository.js";
import { StudyService } from "./features/study/service.js";
import { IndexedDbPersistence } from "./persistence/indexeddb.js";
import { RECORD_KINDS } from "./persistence/contracts.js";

const freeze = Object.freeze;
const {
  installNotificationController,
  renderNotification,
  synchronizeNotification,
} = await import(
  "./features/notifications/controller.js"
);

/** @import { CatalogCandidate, QuizVersion } from "./features/catalog/contracts.js" */
/** @import { FeedPage, FeedPolicy, RankedFeedItem } from "./features/feed/contracts.js" */
/** @import { PersistenceEnvelope, RecordKind } from "./persistence/contracts.js" */
/** @import { ExposureCommand } from "./features/exposure/contracts.js" */
/** @import { AudioContextPort, ExperienceSettings, SettingsFailure, ViewTransitionCapability } from "./features/experience/contracts.js" */
/** @import { PreferenceCommand } from "./features/preference/contracts.js" */
/** @import { RecallCommand, RecallPrompt } from "./features/recall/contracts.js" */
/** @import { RecallService } from "./features/recall/service.js" */
/** @import { StudyCommand, StudyEvent } from "./features/study/contracts.js" */
/** @import { DailyLearningSettings, DailyRecallCohort, DailyResponseFact, DailyStudySet, RecallCandidateRef, StudyCandidateRef } from "./features/daily-learning/contracts.js" */
/** @import { PromptGenerationEvent } from "./features/prompt-bank/contracts.js" */
/** @import { renderReviewRoute, questionResponseFromFormData } from "./routes/review.js" */
/** @import { createLibraryPage } from "./startup/library-page.js" */
/** @import { createDiscoveryPage } from "./startup/discovery-page.js" */
/** @import { createExperienceActions } from "./startup/experience-actions.js" */

const LOCAL_OWNER_ID = "local-owner-v1";
const QUALIFIED_VIEW_MS = 30_000;
const SETTINGS_STORAGE_KEY = "resonance:experience";
const PRESETS =
  /** @type {{
   *   readonly visualThemes: readonly import("./features/experience/contracts.js").ExperiencePreset<import("./features/experience/contracts.js").VisualTheme>[],
   *   readonly layouts: readonly import("./features/experience/contracts.js").ExperiencePreset<import("./features/experience/contracts.js").LayoutMode>[]
   * }} */
  (readEmbeddedJson("experience-presets"));
const VISUAL_THEMES = PRESETS.visualThemes;
const LAYOUTS = PRESETS.layouts;
const APP_COPY =
  /** @type {{readonly dailyTargetsCreate:string,readonly savedTargetsHidden:string,readonly savedSetHidden:string,readonly starterUnavailable:string,readonly discoveryUnavailable:string,readonly reviewRouteUnavailable:string,readonly libraryRouteUnavailable:string,readonly recallRuntimeUnavailable:string,readonly preferenceNotSaved:string,readonly preferenceSaveFailed:string,readonly studySaved:string,readonly answerSavedReload:string,readonly promptOutsideRecall:string,readonly exported:string,readonly exportFailed:string,readonly eraseFailed:string,readonly targetsSaved:string,readonly finishRecall:string,readonly soundsUnavailable:string,readonly feedExpired:string,readonly feedUnavailable:string,readonly pageSizeUnsupported:string,readonly cursorInvalid:string,readonly feedOwnerMismatch:string,readonly pageMismatch:string,readonly lessonUnavailable:string,readonly feedOpenFailed:string,readonly storageUnavailable:string,readonly learningDataUnavailable:string,readonly offlineMiss:string,readonly offlineUpgrade:string,readonly offlineFailed:string,readonly settingsRead:string,readonly settingsWrite:string,readonly settingsReset:string,readonly settingsInvalid:string,readonly openingApp:string,readonly discoverFailed:string,readonly reviewOpening:string,readonly libraryOpening:string,readonly discoverMarkup:import("./routes/discover.js").DiscoverMarkup}} */
  (readEmbeddedJson("app-copy"));
const DEFAULT_SETTINGS = freeze({
  schemaVersion: /** @type {const} */ (2),
  themeMode: /** @type {const} */ ("system"),
  visualTheme: /** @type {const} */ ("studio-signal"),
  layoutMode: /** @type {const} */ ("split-desk"),
  soundEnabled: false,
});
/** @type {FeedPolicy} */
const feedPolicy = freeze({
  maxPageSize: 50,
  cursorLifetimeMs: 24 * 60 * 60_000,
  preferenceWeight: 0.45,
  exposurePenalty: 0.12,
  masteryPenalty: 0.4,
  dueBoost: 2,
  explorationFloor: 0.08,
  version: "local-ranking-v1",
});

const rootQuery = document.querySelector("#app");
if (!(rootQuery instanceof HTMLElement)) {
  throw new Error("AppRootMissing");
}
const root = /** @type {HTMLElement} */ (rootQuery);
root.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("button")) {
    void playInteractionCue();
  }
});
const systemThemeQuery = matchMedia("(prefers-color-scheme: dark)");
const reducedMotionQuery = matchMedia("(prefers-reduced-motion: reduce)");
const settingsRepository = new SettingsRepository({
  storage: resolveSettingsStorage(),
  key: SETTINGS_STORAGE_KEY,
  ownerId: LOCAL_OWNER_ID,
  visualThemes: VISUAL_THEMES,
  layouts: LAYOUTS,
  defaultVisualTheme: DEFAULT_SETTINGS.visualTheme,
  defaultLayoutMode: DEFAULT_SETTINGS.layoutMode,
});
const transitions = resolveTransitionCapability(document);
const correctAudio = new FeedbackAudioService({
  createContext: resolveAudioContextFactory(),
  cue: freeze({
    frequencyHz: 740,
    durationSeconds: 0.1,
    peakGain: 0.025,
    oscillatorType: /** @type {const} */ ("sine"),
  }),
});
const incorrectAudio = new FeedbackAudioService({
  createContext: resolveAudioContextFactory(),
  cue: freeze({
    frequencyHz: 220,
    durationSeconds: 0.12,
    peakGain: 0.02,
    oscillatorType: /** @type {const} */ ("triangle"),
  }),
});
const interactionAudio = new FeedbackAudioService({
  createContext: resolveAudioContextFactory(),
  cue: freeze({
    frequencyHz: 392,
    durationSeconds: 0.06,
    peakGain: 0.018,
    oscillatorType: /** @type {const} */ ("sine"),
  }),
});

const {
  DailyLearningRepository,
  DailyLearningService,
  persistRecallCohort,
} = await import("./features/daily-learning/runtime.js");
const catalogResponse = await fetch("./assets/catalog-fixtures.json");
if (!catalogResponse.ok) {
  throw new Error("FixtureCatalogLoadFailed");
}
const catalogFixtures =
  /** @type {readonly CatalogCandidate[]} */ (await catalogResponse.json());
const catalogResult = CatalogRepository.create(
  catalogFixtures,
);
if (!catalogResult.ok) {
  throw new Error(`Fixture catalog invalid: ${catalogResult.error.kind}`);
}

const catalog = catalogResult.value;
const candidates = catalog.list();
const candidateIds = new Set(candidates.map((candidate) => candidate.id));
const preferenceScopes = new Set(candidates.map(scopeForCandidate));
/** @type {Map<string, RecallPrompt>} */
const prompts = new Map(candidates.map((candidate) => {
  const prompt = createRecallPrompt(
    candidate.quiz.id,
    candidate.id,
    `${candidate.knowledgeUnitIds[0]}:${candidate.quiz.id}`,
    candidate.quiz.prompt,
  );
  return [prompt.id, prompt];
}));

const persistence = new IndexedDbPersistence();
const {
  FeedService,
  FixturePromptRuntime,
  createFeedSourceEligibility,
  restoreLocalState,
} = await import(
  "./startup/local-runtime.js"
);
const promptRuntime = new FixturePromptRuntime({
  candidates,
  ownerId: LOCAL_OWNER_ID,
  now: () => new Date().toISOString(),
  write: async (event) => {
    const result = await persistence.append({
      id: event.idempotencyKey,
      ownerId: event.ownerId,
      kind: "prompt_generation",
      payloadJson: JSON.stringify(event),
      recordedAt: event.generatedAt,
    });
    return result.ok
      ? { ok: true, value: /** @type {const} */ (true) }
      : { ok: false, error: result.error };
  },
});
const preferenceRepository = new PreferenceRepository();
const preferenceService = new PreferenceService(
  preferenceRepository,
  preferenceScopes,
  () => crypto.randomUUID(),
);
const exposureRepository = new ExposureRepository();
const exposureService = new ExposureService(
  exposureRepository,
  candidateIds,
  QUALIFIED_VIEW_MS,
  () => crypto.randomUUID(),
);
const studyRepository = new StudyRepository();
const studyService = new StudyService({
  repository: studyRepository,
  knownCandidates: candidateIds,
  createId: () => crypto.randomUUID(),
  writeEvent: async (command) => {
    const persisted = await persistence.append({
      id: command.idempotencyKey,
      ownerId: command.ownerId,
      kind: "manual_study",
      payloadJson: JSON.stringify(command),
      recordedAt: command.occurredAt,
    });
    return persisted.ok ? { ok: true, value: /** @type {const} */ (true) } : {
      ok: false,
      error: { kind: /** @type {const} */ ("StudyWriteUnavailable") },
    };
  },
});
const recallRepository = new RecallRepository();
/** @type {RecallService | null} */
let recallService = null;
/** @type {RecallCommand[]} */
const restoredRecallCommands = [];
/** @type {Map<string, string>} */
const recallSourceRecords = new Map();
/** @type {{ recordId: string, reason: string }[]} */
const incompatibleRecallRecords = [];
/** @type {string | null} */
let recallRuntimeIssue = null;
/** @type {{ readonly kind: "LocalStateReadFailed" | "LocalStateCorrupt", readonly message: string } | null} */
let startupRestoreIssue = null;
const dailyLearningRepository = new DailyLearningRepository();
const dailyLearningService = new DailyLearningService({
  repository: dailyLearningRepository,
  selector: freeze({
    version: "ranked-daily-selector-v1",
    select: (input) => freeze(input.candidates.slice(0, input.count)),
  }),
  createId: () => crypto.randomUUID(),
});

let activeView = parseRoute(location.hash).view;
let libraryPage = parseRoute(location.hash).libraryPage;
let reviewMode = parseRoute(location.hash).reviewMode;
let scheduledPromptId = parseRoute(location.hash).scheduledPromptId;
let discoveryItemId = parseRoute(location.hash).discoveryItemId;
/** @type {import("./features/feed/service.js").FeedService | null} */
let feedService = null;
/** @type {FeedPage | null} */
let feedPage = null;
/** @type {RankedFeedItem[]} */
let visibleItems = [];
let revealedStudyItems = 1;
/** @type {DailyLearningSettings | null} */
let dailySettings = null;
/** @type {DailyResponseFact[]} */
const dailyResponseFacts = [];
/** @type {Map<string, { readonly response: string, readonly explanation: string }>} */
const openResponses = new Map();
/** @type {ReturnType<typeof setTimeout> | null} */
let promptEligibilityTimer = null;
let activeQuestionIndex = 0;
/** @type {string | null} */
let reviewFeedbackPromptId = null;
/** @type {typeof renderReviewRoute | null} */
let reviewRenderer = null;
/** @type {typeof questionResponseFromFormData | null} */
let reviewResponseFromForm = null;
/** @type {Promise<void> | null} */
let reviewRouteLoad = null;
/** @type {string | null} */
let reviewRouteIssue = null;
/** @type {ReturnType<typeof createLibraryPage> | null} */
let libraryPageController = null;
/** @type {Promise<void> | null} */
let libraryRouteLoad = null;
/** @type {string | null} */
let libraryRouteIssue = null;
/** @type {ReturnType<typeof createDiscoveryPage> | null} */
let discoveryPage = null;
/** @type {ReturnType<typeof createExperienceActions> | null} */
let experienceActions = null;
/** @type {string | null} */
let notice = null;
/** @type {string | null} */
let errorMessage = null;
const notifications = installNotificationController({
  durationMs: 4_000,
  root,
  document,
  createId: () => crypto.randomUUID(),
  now: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timerId) => clearTimeout(timerId),
  onChange: (notification) => {
    if (notification === null) {
      notice = null;
      errorMessage = null;
    }
    renderMessagesOnly();
  },
});
/** @type {import("./features/review-recovery/service.js").ReviewRecoveryService | null} */
let reviewRecovery = null;

/** @type {"cursor-expired" | null} */
let feedRecovery = null;
/** @type {ExperienceSettings} */
let experienceSettings = DEFAULT_SETTINGS;
/** @type {SettingsFailure | null} */
let settingsIssue = null;
/** @type {Map<string, { readonly message: string, readonly status: "correct" | "incorrect" | "review-required", animate: boolean }>} */
const answerFeedbackByPrompt = new Map();
let settingsOpen = false;
let sessionStartPending = false;
/** @type {IntersectionObserver | null} */
let studyObserver = null;
/** @type {IntersectionObserver | null} */
let feedRevealObserver = null;
/** @type {Map<string, number>} */
const passiveExposureTimers = new Map();
/** @type {Set<string>} */
const passiveExposureInFlight = new Set();
/** @type {Set<string>} */
const dismissedPreferencePrompts = new Set();
/** @type {Set<string>} */
const pendingWrites = new Set();

loadExperienceSettings();
applyExperiencePresentation();
renderLoading();
await initialize();

async function initialize() {
  const restored = await restoreLocalState({
    ownerId: LOCAL_OWNER_ID,
    persistence,
    dailyLearningRepository,
    promptRuntime,
    preferenceService,
    exposureService,
    studyRepository,
    studyService,
  });
  if (!restored.ok) {
    startupRestoreIssue = restoreRecoveryFor(restored.error);
    render();
    registerOfflineSupport();
    return;
  }
  dailySettings = restored.value.dailySettings;
  dailyResponseFacts.push(...restored.value.responseFacts);
  restoredRecallCommands.push(...restored.value.recallCommands);
  for (const [idempotencyKey, recordId] of restored.value.recallSourceRecords) {
    recallSourceRecords.set(idempotencyKey, recordId);
  }
  incompatibleRecallRecords.push(...restored.value.incompatibleRecallRecords);
  for (const [promptId, response] of restored.value.openResponses) {
    openResponses.set(promptId, response);
  }
  if (!(await persistCatalog())) {
    render();
    return;
  }
  if (!(await ensureDailySettings())) {
    render();
    return;
  }
  await startFeedSession();
  await refreshPromptAvailability();
  if (!(await ensureDailyStudySet())) {
    render();
    return;
  }
  await loadActiveRoute();
  render();
  registerOfflineSupport();
}

/** @returns {Promise<boolean>} */
async function persistCatalog() {
  for (const candidate of candidates) {
    const persisted = await appendEnvelope({
      id: `catalog:${candidate.id}`,
      ownerId: LOCAL_OWNER_ID,
      kind: "catalog",
      payloadJson: JSON.stringify(candidate),
      recordedAt: candidate.discovery.retrievedAt,
    }, true);
    if (!persisted) return false;
  }
  return true;
}

/** @returns {Promise<boolean>} */
async function ensureDailySettings() {
  const restored = dailyLearningRepository.getSettings(LOCAL_OWNER_ID);
  if (restored !== null) {
    dailySettings = restored;
    return true;
  }
  const now = new Date().toISOString();
  const saved = dailyLearningService.saveSettings({
    ownerId: LOCAL_OWNER_ID,
    dailyStudyTarget: 5,
    dailyRecallLimit: 3,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    expectedRevision: 0,
    updatedAt: now,
  });
  if (!saved.ok) {
    errorMessage = APP_COPY.dailyTargetsCreate;
    return false;
  }
  return await commitDailySettings(saved.value);
}

/** @param {DailyLearningSettings} settings */
async function commitDailySettings(settings) {
  dailyLearningRepository.rollbackSettings(
    settings.ownerId,
    settings.revision,
  );
  const persisted = await appendEnvelope({
    id: `daily-settings:${settings.ownerId}:${settings.revision}`,
    ownerId: settings.ownerId,
    kind: "daily_learning_settings",
    payloadJson: JSON.stringify(settings),
    recordedAt: settings.updatedAt,
  }, false);
  if (!persisted) return false;
  const committed = dailyLearningRepository.recordSettings(settings);
  if (!committed.ok) {
    errorMessage = APP_COPY.savedTargetsHidden;
    return false;
  }
  dailySettings = committed.value;
  return true;
}

/** @returns {Promise<boolean>} */
async function ensureDailyStudySet() {
  if (dailySettings === null || feedPage === null) return false;
  const day = learningDay(dailySettings.timeZone);
  const existing = dailyLearningRepository.listStudySets(LOCAL_OWNER_ID, day);
  if (existing.length === 0) {
    const now = new Date().toISOString();
    const created = dailyLearningService.createStudySet({
      ownerId: LOCAL_OWNER_ID,
      learningDay: day,
      idempotencyKey: `daily-set:${LOCAL_OWNER_ID}:${day}:1`,
      createdAt: now,
      candidates: feedPage.items.map((/** @type {RankedFeedItem} */ item) => {
        const candidate = candidates.find((entry) =>
          entry.id === item.candidateId
        );
        return {
          contentId: item.candidateId,
          contentVersion: 1,
          promptIds: candidate === undefined ? [] : [candidate.quiz.id],
        };
      }),
    });
    if (!created.ok) {
      errorMessage = created.error.kind ===
          "DailyAssignmentInsufficientCandidates"
        ? `Today's set needs ${created.error.required} items; ${created.error.available} available.`
        : "Today's set could not be assigned.";
      return false;
    }
    if (!(await commitStudySet(created.value))) return false;
  }
  for (
    const set of dailyLearningRepository.listStudySets(LOCAL_OWNER_ID, day)
  ) {
    if (!(await issueRecallCohort(set))) return false;
  }
  syncVisibleAssignment();
  return true;
}

/** @param {DailyStudySet} studySet */
async function commitStudySet(studySet) {
  dailyLearningRepository.rollbackStudySet(
    studySet.ownerId,
    studySet.idempotencyKey,
  );
  const persisted = await appendEnvelope({
    id: studySet.idempotencyKey,
    ownerId: studySet.ownerId,
    kind: "daily_study_set",
    payloadJson: JSON.stringify(studySet),
    recordedAt: studySet.createdAt,
  }, false);
  if (!persisted) return false;
  const committed = dailyLearningRepository.recordStudySet(studySet);
  if (!committed.ok) {
    errorMessage = APP_COPY.savedSetHidden;
    return false;
  }
  return true;
}

/** @param {DailyStudySet} studySet */
async function issueRecallCohort(studySet) {
  const result = await persistRecallCohort(studySet, {
    ownerId: LOCAL_OWNER_ID,
    now: () => new Date().toISOString(),
    repository: dailyLearningRepository,
    service: dailyLearningService,
    promptRuntime,
    prompts,
    studyRepository,
    recallRepository,
    append: (envelope) => appendEnvelope(envelope, false),
  });
  if (!result.ok) {
    errorMessage = result.error.kind === "RecallCohortCommitFailed"
      ? "Saved recall is hidden. Reload."
      : "Today's recall could not be assigned.";
    return false;
  }
  return true;
}

function syncVisibleAssignment() {
  if (dailySettings === null || feedPage === null) {
    visibleItems = [];
    return;
  }
  const assigned = dailyLearningRepository.listStudySets(
    LOCAL_OWNER_ID,
    learningDay(dailySettings.timeZone),
  ).flatMap((set) => set.items);
  const ranked = new Map(
    feedPage.items.map((/** @type {RankedFeedItem} */ item) => [
      item.candidateId,
      item,
    ]),
  );
  visibleItems = assigned.slice(0, revealedStudyItems).flatMap((item) => {
    const rankedItem = ranked.get(item.contentId);
    return rankedItem === undefined ? [] : [rankedItem];
  });
}

async function refreshPromptAvailability() {
  if (promptEligibilityTimer !== null) clearTimeout(promptEligibilityTimer);
  promptEligibilityTimer = null;
  if (dailySettings === null) return;
  const nowMs = Date.now();
  const studied = candidates.flatMap((candidate) => {
    const fact = studyRepository.list(LOCAL_OWNER_ID, candidate.id).at(0);
    return fact === undefined
      ? []
      : [{ candidate, studiedAt: fact.occurredAt }];
  });
  const generation = await promptRuntime.generateDue(studied);
  if (!generation.ok) {
    errorMessage = generation.error.kind === "PromptGenerationPersistenceFailed"
      ? "Recall prompts could not be saved."
      : "Recall prompts could not be prepared.";
    return;
  }
  if (generation.value.nextEligibleAt !== null) {
    promptEligibilityTimer = setTimeout(
      () => {
        void refreshPromptAvailability().then(() => render());
      },
      Math.min(
        2_147_483_647,
        Math.max(0, Date.parse(generation.value.nextEligibleAt) - nowMs),
      ),
    );
  }
  for (const generated of generation.value.prompts) {
    if (prompts.has(generated.id)) continue;
    const candidate = candidates.find((item) =>
      item.id === generated.contentId
    );
    if (candidate === undefined) continue;
    prompts.set(
      generated.id,
      createRecallPrompt(
        generated.id,
        generated.contentId,
        `${
          candidate.knowledgeUnitIds[0]
        }:${generated.id}:v${generated.version}`,
        generated.prompt,
      ),
    );
  }
  await Promise.all(
    dailyLearningRepository.listStudySets(
      LOCAL_OWNER_ID,
      learningDay(dailySettings.timeZone),
    ).map(issueRecallCohort),
  );
}

/** @param {string} id @param {string} contentId @param {string} knowledgeUnitId @param {string} promptText @returns {RecallPrompt} */
function createRecallPrompt(id, contentId, knowledgeUnitId, promptText) {
  return freeze({
    id,
    contentId,
    knowledgeUnitId,
    prompt: promptText,
    choices: freeze([
      freeze({ id: `${id}-grade-correct`, label: "Correct" }),
      freeze({ id: `${id}-grade-incorrect`, label: "Needs work" }),
    ]),
    correctChoiceId: `${id}-grade-correct`,
    status: "active",
  });
}

async function loadActiveRoute() {
  if (startupRestoreIssue !== null) return;
  if (activeView === "review") {
    await Promise.all([loadReviewRoute(), ensureRecallRuntime()]);
  }
  if (activeView === "library") {
    await loadLibraryRoute();
    if (libraryPage === "review-queue") {
      await ensureRecallRuntime();
      await libraryPageController?.loadReviewQueue();
    }
  }
  if (activeView === "discover") {
    if (discoveryPage === null) {
      /** @type {unknown} */ let starterInventory = null;
      try {
        const response = await fetch("./assets/discovery-starters.json");
        if (response.ok) starterInventory = await response.json();
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
      const module = await import("./startup/discovery-page.js");
      discoveryPage = module.createDiscoveryPage({
        ownerId: LOCAL_OWNER_ID,
        persistence,
        fetch,
        gatewayBaseUrl: new URL("./", location.href).href,
        policyStorage: globalThis.localStorage,
        starterInventory,
        markup: APP_COPY.discoverMarkup,
        createId: () => crypto.randomUUID(),
        now: () => new Date().toISOString(),
        escapeHtml,
        onNotice: (message) => {
          notice = message;
          errorMessage = null;
        },
        onError: (message) => {
          errorMessage = message;
          notice = null;
        },
        navigateToLibrary: () => {
          void libraryPageController?.load().catch(() => {
            libraryRouteIssue = APP_COPY.libraryRouteUnavailable;
            render();
          });
          activeView = "library";
          libraryPage = "collection";
          location.hash = "library";
        },
        rerender: () => render(),
      });
    }
    const loaded = await discoveryPage.load();
    if (!loaded.ok) {
      errorMessage = APP_COPY.discoveryUnavailable;
    }
  }
}

async function loadReviewRoute() {
  if (reviewRenderer !== null) return;
  reviewRouteLoad ??= import("./routes/review.js").then((module) => {
    reviewRenderer = module.renderReviewRoute;
    reviewResponseFromForm = module.questionResponseFromFormData;
    reviewRouteIssue = null;
  }).catch(() => {
    reviewRouteIssue = APP_COPY.reviewRouteUnavailable;
  }).finally(() => {
    reviewRouteLoad = null;
  });
  await reviewRouteLoad;
}

async function loadLibraryRoute() {
  if (libraryPageController !== null) return;
  libraryRouteLoad ??= import("./startup/library-page.js").then(
    async (module) => {
      libraryPageController = module.createLibraryPage({
        fetch,
        gatewayBaseUrl: new URL("./", location.href).href,
        escapeHtml,
        formatDate,
        createId: () => crypto.randomUUID(),
        now: () => new Date().toISOString(),
        confirmDisable: (source) =>
          confirm(
            `Remove "${source.title}" from future ingestion and Feed selection? Study and review history will be preserved.`,
          ),
        createObserver: (load) => {
          if (!("IntersectionObserver" in globalThis)) return null;
          const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) load();
          }, { rootMargin: "400px 0px" });
          return {
            observe: (element) => observer.observe(element),
            disconnect: () => observer.disconnect(),
          };
        },
        onNotice: (message) => {
          notice = message;
          errorMessage = null;
        },
        onError: (message) => {
          errorMessage = message;
          notice = null;
        },
        rerender: () => render(),
      });
      await libraryPageController.load();
    },
  ).then(() => {
    libraryRouteIssue = null;
  }).catch(() => {
    libraryRouteIssue = APP_COPY.libraryRouteUnavailable;
  }).finally(() => {
    libraryRouteLoad = null;
  });
  await libraryRouteLoad;
}

async function ensureRecallRuntime() {
  if (recallService !== null) return true;
  let modules;
  try {
    modules = await Promise.all([
      import("./features/recall/service.js"),
      import("./features/recall/ts-fsrs-adapter.js"),
    ]);
  } catch {
    recallRuntimeIssue = APP_COPY.recallRuntimeUnavailable;
    return false;
  }
  const [{ RecallService }, { createTsFsrsScheduler }] = modules;
  const service = new RecallService(
    recallRepository,
    prompts,
    createTsFsrsScheduler({
      requestRetention: 0.9,
      maximumInterval: 36_500,
      enableFuzz: false,
      enableShortTerm: true,
      learningSteps: ["1m", "10m"],
      relearningSteps: ["10m"],
    }),
    () => crypto.randomUUID(),
  );
  for (const command of restoredRecallCommands) {
    const replayed = service.answer(command);
    if (!replayed.ok) {
      const recordId = recallSourceRecords.get(command.idempotencyKey) ??
        command.idempotencyKey;
      if (
        !incompatibleRecallRecords.some((record) =>
          record.recordId === recordId
        )
      ) {
        incompatibleRecallRecords.push({
          recordId,
          reason: replayed.error.kind,
        });
      }
    }
  }
  recallService = service;
  recallRuntimeIssue = null;
  return true;
}

/** @returns {Promise<boolean>} */
async function startFeedSession() {
  stopStudyTracking();
  notice = null;
  errorMessage = null;
  feedRecovery = null;
  cancelAllPassiveTimers();
  dismissedPreferencePrompts.clear();
  const now = new Date().toISOString();
  const feedCandidates = candidates.map((candidate) => {
    const scope = scopeForCandidate(candidate);
    const preference = preferenceService.snapshot(LOCAL_OWNER_ID, scope);
    const exposureCount =
      exposureRepository.list(LOCAL_OWNER_ID, candidate.id).length;
    const memory = recallRepository.getMemory(
      LOCAL_OWNER_ID,
      prompts.get(candidate.quiz.id)?.knowledgeUnitId ??
        candidate.knowledgeUnitIds[0],
    );
    return freeze({
      candidateId: candidate.id,
      sourceId: candidate.librarySourceId,
      title: candidate.title,
      knowledgeUnitIds: candidate.knowledgeUnitIds,
      eligible: true,
      signals: freeze({
        preference: preference.affinity,
        qualifiedExposures: exposureCount,
        mastery: memory === null ? null : Math.min(0.95, memory.stability / 30),
        dueAt: memory?.dueAt ?? null,
      }),
    });
  });
  const sourceEligibility = await createFeedSourceEligibility({
    fetch,
    baseUrl: new URL("./", location.href).href,
    ownerId: LOCAL_OWNER_ID,
    candidates: feedCandidates,
  });
  if (!sourceEligibility.ok) {
    errorMessage = friendlyFailure("SourceEligibilityUnavailable");
    feedPage = null;
    visibleItems = [];
    return false;
  }
  feedService = new FeedService(
    feedCandidates,
    feedPolicy,
    () => crypto.randomUUID(),
    (candidateId) => catalog.get(candidateId).ok,
    sourceEligibility.value,
  );
  const result = feedService.getPage({
    ownerId: LOCAL_OWNER_ID,
    limit: candidates.length,
    now,
  });
  if (!result.ok) {
    errorMessage = friendlyFailure(result.error.kind);
    feedPage = null;
    visibleItems = [];
    return false;
  }
  const persisted = await appendEnvelope({
    id: `feed:${result.value.sessionId}:page:0`,
    ownerId: LOCAL_OWNER_ID,
    kind: "feed_session",
    payloadJson: JSON.stringify(result.value),
    recordedAt: now,
  }, false);
  if (!persisted) {
    feedPage = null;
    visibleItems = [];
    return false;
  }
  feedPage = result.value;
  syncVisibleAssignment();
  return true;
}

function renderLoading() {
  root.innerHTML = APP_COPY.openingApp;
}

/**
 * @param {string | null} [preferredFocusKey]
 * @param {string | null} [fallbackHeadingId]
 */
function render(preferredFocusKey = null, fallbackHeadingId = null) {
  const activeElement = document.activeElement;
  const previousFocusKey = activeElement instanceof HTMLElement
    ? activeElement.dataset.focusKey ?? null
    : null;
  stopStudyTracking();
  feedRevealObserver?.disconnect();
  feedRevealObserver = null;
  synchronizeNotification(notifications, notice, errorMessage);
  root.innerHTML =
    `<div class="app-shell">${renderHeader()}<main class="workspace" id="main-content" tabindex="-1" data-layout="${experienceSettings.layoutMode}">${
      startupRestoreIssue !== null
        ? renderStartupRecovery()
        : `${activeView === "feed" ? renderFeed() : ""}${
          activeView === "review" ? renderReviewView() : ""
        }${activeView === "library" ? renderLibraryView() : ""}${
          activeView === "discover" ? renderDiscoverView() : ""
        }`
    }</main><div class="toast-region" aria-atomic="true">${
      renderNotification(notifications.current(), escapeHtml)
    }</div></div>`;
  bindInteractions();
  startStudyTracking();
  restoreFocus(preferredFocusKey ?? previousFocusKey, fallbackHeadingId);
  for (const feedback of answerFeedbackByPrompt.values()) {
    feedback.animate = false;
  }
}

function renderStartupRecovery() {
  if (startupRestoreIssue === null) return "";
  return `<section class="wide-view state-panel" aria-labelledby="restore-title">
    <p class="eyebrow">Saved learning</p>
    <h1 id="restore-title">Your saved learning needs attention</h1>
    <p>${escapeHtml(startupRestoreIssue.message)}</p>
    <p>Your saved answers have not been changed. Export a backup before resetting this browser's learning data.</p>
    <div class="state-actions">
      <button class="button secondary" type="button" data-action="export">Export backup</button>
      <button class="button primary" type="button" data-action="reset">Reset local data</button>
    </div>
  </section>`;
}

function renderHeader() {
  return `<header class="topbar"><button class="brand" type="button" data-view="feed" data-focus-key="brand" aria-label="Resonance home"><span class="brand-mark" aria-hidden="true">R</span><span>Resonance</span></button><nav class="primary-nav" aria-label="Primary">${
    navButton("feed", "Feed")
  }${navButton("discover", "Discover")}${navButton("review", "Review")}${
    navButton("library", "Library")
  }</nav><div class="topbar-actions"><span class="local-badge">${
    navigator.onLine ? "Local mode" : "Offline"
  }</span>${renderSettings()}</div></header>`;
}

function renderDiscoverView() {
  if (discoveryPage === null) {
    return APP_COPY.discoverFailed;
  }
  return discoveryPage.render({
    selectedItemId: discoveryItemId,
    online: navigator.onLine,
  });
}

function renderSettings() {
  return `<details class="settings-menu" ${
    settingsOpen ? "open" : ""
  }><summary class="button quiet" data-focus-key="settings-summary">Settings</summary><div class="settings-panel"><fieldset class="settings-group"><legend>Visual theme</legend><div class="segmented-control">${
    VISUAL_THEMES.map((preset) =>
      presetOption(
        "visual-theme",
        preset.id,
        preset.label,
        experienceSettings.visualTheme,
      )
    ).join("")
  }</div></fieldset><fieldset class="settings-group"><legend>Workspace layout</legend><div class="segmented-control">${
    LAYOUTS.map((preset) =>
      presetOption(
        "layout",
        preset.id,
        preset.label,
        experienceSettings.layoutMode,
      )
    ).join("")
  }</div></fieldset><fieldset class="settings-group"><legend>Appearance</legend><div class="segmented-control">${
    themeOption("system", "System")
  }${themeOption("light", "Light")}${
    themeOption("dark", "Dark")
  }</div></fieldset><label class="switch-control"><span><strong>Interface sounds</strong><small>Interaction and quiz cues</small></span><input type="checkbox" data-setting="sound" data-focus-key="setting-sound" ${
    experienceSettings.soundEnabled ? "checked" : ""
  }></label><form class="daily-settings-form" data-daily-settings-form><fieldset class="settings-group"><legend>Daily learning</legend><label for="daily-study-target">Daily study target</label><input id="daily-study-target" name="daily-study-target" type="number" min="1" max="50" step="1" value="${
    dailySettings?.dailyStudyTarget ?? 5
  }"><label for="daily-recall-limit">Daily recall limit</label><input id="daily-recall-limit" name="daily-recall-limit" type="number" min="0" max="49" step="1" value="${
    dailySettings?.dailyRecallLimit ?? 3
  }"><p class="settings-form-note">Changes apply to the next assigned set.</p><p class="settings-form-error" data-daily-settings-error tabindex="-1"></p><button class="button secondary" type="submit">Save learning targets</button></fieldset></form>${
    settingsIssue === null ? "" : `<div class="settings-recovery" role="status">
            <p>${escapeHtml(friendlySettingsFailure(settingsIssue.kind))}</p>
            <button class="button secondary" type="button" data-action="reset-settings" data-focus-key="reset-settings">Reset display settings</button>
          </div>`
  }</div></details>`;
}

/**
 * @param {"visual-theme" | "layout"} setting
 * @param {string} value
 * @param {string} label
 * @param {string} selected
 */
function presetOption(setting, value, label, selected) {
  return `<label><input type="radio" name="${setting}" value="${value}" data-setting="${setting}" data-focus-key="${setting}-${value}" ${
    selected === value ? "checked" : ""
  }><span>${label}</span></label>`;
}

/** @param {"system" | "light" | "dark"} mode @param {string} label */
function themeOption(mode, label) {
  return `<label><input type="radio" name="theme-mode" value="${mode}" data-setting="theme" data-focus-key="theme-${mode}" ${
    experienceSettings.themeMode === mode ? "checked" : ""
  }><span>${label}</span></label>`;
}

function renderFeed() {
  if (errorMessage && visibleItems.length === 0) {
    return `
      <section class="feed-column state-panel" aria-labelledby="feed-title">
        <p class="eyebrow">Feed</p>
        <h1 id="feed-title">Your feed needs attention</h1>
        <p>${escapeHtml(errorMessage)}</p>
        <button class="button primary" type="button" data-action="retry">Try again</button>
      </section>
    `;
  }
  if (visibleItems.length === 0) {
    return `
      <section class="feed-column state-panel" aria-labelledby="feed-title">
        <p class="eyebrow">Feed</p>
        <h1 id="feed-title">Nothing is ready yet</h1>
        <button class="button primary" type="button" data-action="retry">Refresh</button>
      </section>
    `;
  }

  return `
    <section class="feed-column" aria-labelledby="feed-title">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Today</p>
          <h1 id="feed-title">Learning feed</h1>
        </div>
      </div>
      <div class="feed-stack">
        ${visibleItems.map(renderFeedItem).join("")}
      </div>
      <div class="feed-end" ${
    hasHiddenAssignedItems() ? "data-feed-reveal" : ""
  }>
        ${
    hasHiddenAssignedItems()
      ? `<button class="button secondary" type="button" data-action="load-more" data-focus-key="load-more" ${
        "IntersectionObserver" in globalThis ? "hidden" : ""
      }>Load more</button>`
      : renderNextSetControl()
  }
      </div>
    </section>
    ${renderLearningSnapshot()}
  `;
}

function renderLearningSnapshot() {
  const sets = currentStudySets();
  const progress = dailyLearningService.calculateProgress(
    sets,
    studiedContentIds(),
  );
  const studied = progress.ok ? progress.value.studied : 0;
  const assigned = progress.ok ? progress.value.assigned : 0;
  return `
    <aside class="learning-snapshot" aria-labelledby="snapshot-title">
      <div class="snapshot-heading">
        <p class="eyebrow">Progress</p>
        <h2 id="snapshot-title">Learning snapshot</h2>
      </div>
      <div class="snapshot-progress">
        <div><span>Daily studied</span><strong>${studied} of ${assigned}</strong></div>
        <progress
          aria-label="${studied} of ${assigned} assigned lessons studied today"
          value="${studied}"
          max="${Math.max(1, assigned)}"
        >${studied} of ${assigned}</progress>
      </div>
    </aside>
  `;
}

/** @param {RankedFeedItem} item */
function renderFeedItem(item) {
  const result = catalog.get(item.candidateId);
  if (!result.ok) return "";
  const candidate = result.value;
  const studied = studyRepository.list(LOCAL_OWNER_ID, candidate.id).length > 0;
  const preference = preferenceService.snapshot(
    LOCAL_OWNER_ID,
    scopeForCandidate(candidate),
  );
  const accentSlot = accentSlotFor(candidate.id, 3) + 1;

  return `
    <article class="learning-card signal-${accentSlot}" data-candidate-id="${
    escapeHtml(candidate.id)
  }">
      <div class="card-media">
        <img
          src="${escapeHtml(candidate.artworkPath)}"
          srcset="${
    escapeHtml(candidate.artworkCompactPath)
  } ${candidate.artworkCompactWidth}w, ${
    escapeHtml(candidate.artworkPath)
  } ${candidate.artworkWidth}w"
          sizes="(max-width: 800px) 100vw, (min-width: 1200px) 680px, 56vw"
          alt=""
          width="${candidate.artworkWidth}"
          height="${candidate.artworkHeight}"
          loading="lazy"
          decoding="async"
        >
        <span class="format-badge">${escapeHtml(candidate.formatLabel)} · ${
    escapeHtml(candidate.durationLabel)
  }</span>
      </div>
      <div class="card-body">
        <p class="selection-reason">${escapeHtml(item.whyShown)}</p>
        <h2 tabindex="-1" data-focus-key="card-heading:${
    escapeHtml(candidate.id)
  }">${escapeHtml(candidate.title)}</h2>
        <p class="publisher">${escapeHtml(candidate.publisher)}</p>
        <p>${escapeHtml(candidate.summary)}</p>
        <details class="source-details">
          <summary>Source and rights</summary>
          <dl>
            <div><dt>Source</dt><dd>${
    escapeHtml(candidate.discovery.sourceLabel)
  }</dd></div>
            <div><dt>Rights</dt><dd>${
    escapeHtml(candidate.rights.basis)
  }</dd></div>
          </dl>
        </details>
        <div class="study-row">
          <button
            class="button secondary"
            type="button"
            data-action="mark-studied"
            data-candidate-id="${escapeHtml(candidate.id)}"
            data-focus-key="study:${escapeHtml(candidate.id)}"
            ${
    studied || pendingWrites.has(studyKey(candidate.id, 1)) ? "disabled" : ""
  }
          >${studied ? "Studied" : "Mark studied"}</button>
          <span class="signal-summary">Preference ${
    formatAffinity(preference.affinity)
  }</span>
        </div>
        ${
    studied
      ? `<p class="recall-ready-time">Recall ready after <time datetime="${
        escapeHtml(recallAvailableAt(candidate.id))
      }">${escapeHtml(formatDate(recallAvailableAt(candidate.id)))}</time></p>`
      : ""
  }
        ${renderPreferencePrompt(candidate)}
      </div>
    </article>
  `;
}

/**
 * @param {CatalogCandidate} candidate
 * @param {RecallPrompt} prompt
 */
function renderQuiz(candidate, prompt) {
  const memory = recallRepository.getMemory(
    LOCAL_OWNER_ID,
    prompt.knowledgeUnitId,
  );
  const choices = /** @type {readonly {
     *   readonly id: string,
     *   readonly label: string
     * }[]} */
    (prompt.choices);
  const answerFeedback = answerFeedbackByPrompt.get(prompt.id);
  return `
    <form class="quiz-panel" data-quiz-id="${escapeHtml(prompt.id)}">
      <fieldset>
        <legend>${escapeHtml(prompt.prompt)}</legend>
        <div class="quiz-options">
          ${
    choices.map((choice) => `
            <label>
              <input type="radio" name="answer-${
      escapeHtml(prompt.id)
    }" value="${escapeHtml(choice.id)}">
              <span>${escapeHtml(choice.label)}</span>
            </label>
          `).join("")
  }
        </div>
      </fieldset>
      <div class="quiz-footer">
        <button class="button primary" type="submit" ${
    pendingWrites.has(`review:${prompt.id}`) ? "disabled" : ""
  } data-focus-key="quiz-submit:${escapeHtml(prompt.id)}">Check answer</button>
        ${
    memory
      ? `<span>Review ${memory.reviewCount} · next ${
        formatDate(memory.dueAt)
      }</span>`
      : `<span>First review</span>`
  }
      </div>
      <p class="answer-feedback ${
    answerFeedback
      ? `is-${answerFeedback.status}${
        answerFeedback.animate ? " animate-confirmation" : ""
      }`
      : ""
  }" data-feedback-for="${escapeHtml(candidate.quiz.id)}" aria-live="polite">${
    answerFeedback ? escapeHtml(answerFeedback.message) : ""
  }</p>
    </form>
  `;
}

/** @param {CatalogCandidate} candidate */
function renderPreferencePrompt(candidate) {
  if (
    feedPage === null ||
    dismissedPreferencePrompts.has(
      preferencePromptKey(feedPage.sessionId, candidate.id),
    )
  ) {
    return "";
  }
  return `
    <section class="preference-panel" aria-label="Tune recommendations">
      <p>Should related lessons appear more often?</p>
      <div class="preference-controls">
        <button class="button preference-more" type="button" data-preference="more" data-candidate-id="${
    escapeHtml(candidate.id)
  }" data-focus-key="preference-more:${escapeHtml(candidate.id)}">More</button>
        <button class="button preference-less" type="button" data-preference="less" data-candidate-id="${
    escapeHtml(candidate.id)
  }" data-focus-key="preference-less:${escapeHtml(candidate.id)}">Less</button>
        <button class="button quiet" type="button" data-action="not-now" data-candidate-id="${
    escapeHtml(candidate.id)
  }" data-focus-key="preference-later:${
    escapeHtml(candidate.id)
  }">Not now</button>
      </div>
    </section>
  `;
}

function renderReviewView() {
  if (reviewRouteIssue !== null) {
    return renderRouteFailure("review", "Review", reviewRouteIssue);
  }
  if (reviewRenderer === null) {
    return APP_COPY.reviewOpening;
  }
  if (recallRuntimeIssue !== null) {
    return renderRouteFailure("review", "Review", recallRuntimeIssue);
  }
  if (incompatibleRecallRecords.length > 0) {
    return `<section class="review-route wide-view" aria-labelledby="review-title"><div class="section-heading"><div><p class="eyebrow">Saved recall</p><h1 id="review-title">Review history needs attention</h1></div></div><div class="state-panel review-state" role="status"><p>${incompatibleRecallRecords.length} saved review ${
      incompatibleRecallRecords.length === 1 ? "record is" : "records are"
    } incompatible with the current recall format. Quarantine downloads a JSON backup, then marks only these incompatible records so the current recall engine ignores them. It does not delete your history.</p><button class="button primary" type="button" data-action="quarantine-reviews">Export and continue</button></div></section>`;
  }
  const day = currentLearningDay();
  const promptIds = currentStudySets().flatMap((set) =>
    dailyLearningRepository.getCohort(LOCAL_OWNER_ID, set.id)?.prompts.map(
      (/** @type {RecallCandidateRef} */ prompt) => prompt.promptId,
    ) ?? []
  );
  const finalized = new Set(
    dailyResponseFacts.filter((fact) =>
      fact.learningDay === day && fact.finalized
    )
      .map((fact) => fact.promptId),
  );
  const pendingCandidates = promptIds.filter((id) => !finalized.has(id))
    .flatMap((id) => {
      const candidate = candidateForPrompt(id);
      return candidate === undefined ? [] : [candidate];
    });
  const feedbackCandidate = reviewFeedbackPromptId === null
    ? null
    : candidateForPrompt(reviewFeedbackPromptId) ?? null;
  const scheduledResolution = scheduledPromptId === null
    ? null
    : resolveScheduledReview(scheduledPromptId, new Date().toISOString());
  const scheduledCandidate = reviewFeedbackPromptId !== null &&
      reviewFeedbackPromptId === scheduledPromptId
    ? feedbackCandidate
    : scheduledResolution?.candidate ?? null;
  if (
    scheduledPromptId !== null && scheduledCandidate === null &&
    scheduledResolution !== null
  ) {
    return `<section class="review-route wide-view" aria-labelledby="review-title">
      <div class="section-heading"><div><p class="eyebrow">Scheduled recall</p><h1 id="review-title">Review unavailable</h1></div></div>
      <div class="state-panel review-state"><p>${
      escapeHtml(scheduledResolution.message)
    }</p><a class="button secondary" href="#library/review-queue">Return to review queue</a></div>
    </section>`;
  }
  const currentCandidate = feedbackCandidate ?? scheduledCandidate ?? (
    pendingCandidates.length === 0 ? null : pendingCandidates[
      Math.min(activeQuestionIndex, pendingCandidates.length - 1)
    ]
  );
  const dailyAccuracy = dailyLearningService.calculateAccuracy(
    dailyResponseFacts.filter((fact) => fact.learningDay === day),
  );
  const sevenDayCutoff = subtractLearningDays(day, 6);
  const sevenDayAccuracy = dailyLearningService.calculateAccuracy(
    dailyResponseFacts.filter((fact) =>
      fact.learningDay >= sevenDayCutoff && fact.learningDay <= day
    ),
  );
  const feedback = currentCandidate === null
    ? null
    : answerFeedbackByPrompt.get(currentCandidate.quiz.id);
  return reviewRenderer({
    activeTab: reviewMode,
    currentCandidate,
    currentPosition: scheduledCandidate === null
      ? promptIds.length - pendingCandidates.length + 1
      : 1,
    totalPrompts: scheduledCandidate === null ? promptIds.length : 1,
    completedPrompts: scheduledCandidate === null ? finalized.size : 0,
    dailyAccuracy: dailyAccuracy.ok
      ? dailyAccuracy.value
      : { correct: 0, total: 0, percentage: null },
    sevenDayAccuracy: sevenDayAccuracy.ok
      ? sevenDayAccuracy.value
      : { correct: 0, total: 0, percentage: null },
    openResponses: [...openResponses.entries()].flatMap(([promptId, value]) => {
      const candidate = candidateForPrompt(promptId);
      return candidate === undefined ? [] : [{
        candidate,
        response: value.response,
        submittedAtLabel: day,
        matchedConcepts: [],
      }];
    }),
    feedback: feedback == null || currentCandidate === null ? null : {
      promptId: currentCandidate.quiz.id,
      status: feedback.status,
      message: feedback.message,
    },
  }, escapeHtml);
}

/** @param {string | null} dueAt @param {string} now */
function reviewStatus(dueAt, now) {
  if (dueAt === null) return "First review";
  return Date.parse(dueAt) <= Date.parse(now)
    ? "Due now"
    : `Next ${formatDate(dueAt)}`;
}

function renderLibraryView() {
  if (libraryRouteIssue !== null) {
    return renderRouteFailure("library", "Library", libraryRouteIssue);
  }
  if (libraryPageController === null) {
    return APP_COPY.libraryOpening;
  }
  const generatedPrompts = promptRuntime.listPrompts(LOCAL_OWNER_ID);
  return libraryPageController.render({
    queue: generatedPrompts.flatMap((generated) => {
      const candidate = candidates.find((item) =>
        item.id === generated.contentId
      );
      const prompt = prompts.get(generated.id);
      if (candidate === undefined || prompt === undefined) return [];
      const memory = recallRepository.getMemory(
        LOCAL_OWNER_ID,
        prompt.knowledgeUnitId,
      );
      return [{
        promptId: generated.id,
        title: candidate.title,
        dueAt: memory?.dueAt ?? null,
        reviewCount: memory?.reviewCount ?? 0,
      }];
    }).filter((item) => item.reviewCount > 0).sort((left, right) =>
      Date.parse(left.dueAt ?? "1970-01-01") -
      Date.parse(right.dueAt ?? "1970-01-01")
    ),
    page: libraryPage,
    recallAvailable: recallRuntimeIssue === null &&
      incompatibleRecallRecords.length === 0 && recallService !== null,
    now: new Date().toISOString(),
  });
}

/** @param {"review" | "library"} route @param {string} title @param {string} message */
function renderRouteFailure(route, title, message) {
  return `<section class="wide-view state-panel" aria-labelledby="${route}-title"><h1 id="${route}-title">${title}</h1><p>${
    escapeHtml(message)
  }</p><button class="button primary" type="button" data-action="retry-route" data-route="${route}">Try again</button></section>`;
}

/**
 * @param {string} promptId
 * @param {string} now
 * @returns {{ readonly candidate: CatalogCandidate | null, readonly message: string }}
 */
function resolveScheduledReview(promptId, now) {
  const generated = promptRuntime.listPrompts(LOCAL_OWNER_ID).find((prompt) =>
    prompt.id === promptId
  );
  const prompt = prompts.get(promptId);
  const candidate = candidateForPrompt(promptId);
  if (
    generated === undefined || prompt === undefined || candidate === undefined
  ) {
    return {
      candidate: null,
      message: "This scheduled prompt is no longer available.",
    };
  }
  const memory = recallRepository.getMemory(
    LOCAL_OWNER_ID,
    prompt.knowledgeUnitId,
  );
  if (memory === null) {
    return {
      candidate: null,
      message: "This prompt has not entered scheduled review.",
    };
  }
  if (Date.parse(memory.dueAt) > Date.parse(now)) {
    return {
      candidate: null,
      message: `This prompt is next due ${formatDate(memory.dueAt)}.`,
    };
  }
  return { candidate, message: "" };
}

function bindInteractions() {
  root.querySelectorAll("[data-view]").forEach((element) => {
    element.addEventListener("click", () => {
      const view = element.getAttribute("data-view");
      if (
        view === "feed" || view === "discover" || view === "review" ||
        view === "library"
      ) {
        activeView = view;
        scheduledPromptId = null;
        discoveryItemId = null;
        if (view === "library") libraryPage = "collection";
        if (view === "review") reviewMode = "today";
        location.hash = view;
      }
    });
  });
  if (activeView === "discover") discoveryPage?.bind(root);
  if (activeView === "library") libraryPageController?.bind(root);
  root.querySelectorAll("[data-action='new-session']").forEach((element) => {
    element.addEventListener("click", () => void beginNewSession());
  });
  root.querySelector("[data-action='retry']")?.addEventListener(
    "click",
    () => void beginNewSession(),
  );
  root.querySelector("[data-action='load-more']")?.addEventListener(
    "click",
    () => void loadMore(),
  );
  root.querySelector("[data-action='add-study-set']")?.addEventListener(
    "click",
    () => void addDailyStudySet(),
  );
  root.querySelectorAll("[data-preference]").forEach((element) => {
    element.addEventListener("click", () => void recordPreference(element));
  });
  root.querySelectorAll("[data-action='not-now']").forEach((element) => {
    element.addEventListener("click", () => {
      const candidateId = element.getAttribute("data-candidate-id") ?? "";
      if (feedPage !== null) {
        dismissedPreferencePrompts.add(
          preferencePromptKey(feedPage.sessionId, candidateId),
        );
      }
      element.closest(".preference-panel")?.remove();
      focusLessonHeading(candidateId);
      notice = APP_COPY.preferenceNotSaved;
      renderMessagesOnly();
    });
  });
  root.querySelectorAll("[data-action='mark-studied']").forEach((element) => {
    element.addEventListener("click", (event) => {
      void recordManualStudy(
        /** @type {HTMLElement} */ (event.currentTarget),
      );
    });
  });
  root.querySelectorAll("[data-review-answer]").forEach((element) => {
    element.addEventListener("submit", (event) => void answerQuiz(event));
  });
  root.querySelectorAll("[data-review-tab]").forEach((element) => {
    element.addEventListener("click", () => {
      reviewMode = element.getAttribute("data-review-tab") === "open"
        ? "open"
        : "today";
      location.hash = reviewMode === "open" ? "review/open" : "review";
      render();
    });
  });
  root.querySelectorAll("[data-open-grade]").forEach((element) => {
    element.addEventListener("click", () => void finalizeOpenResponse(element));
  });
  root.querySelector("[data-action='next-question']")?.addEventListener(
    "click",
    () => {
      reviewFeedbackPromptId = null;
      activeQuestionIndex = 0;
      if (scheduledPromptId !== null) {
        scheduledPromptId = null;
        location.hash = "library/review-queue";
        return;
      }
      render("review-title", "review-title");
    },
  );
  root.querySelector("[data-action='export']")?.addEventListener(
    "click",
    exportLocalData,
  );
  root.querySelector("[data-action='reset']")?.addEventListener(
    "click",
    resetLocalData,
  );
  root.querySelector("[data-action='quarantine-reviews']")?.addEventListener(
    "click",
    () => void quarantineIncompatibleReviews(),
  );
  root.querySelector("[data-action='retry-route']")?.addEventListener(
    "click",
    (event) => void retryRoute(event.currentTarget),
  );
  root.querySelectorAll("[data-setting='theme']").forEach((element) => {
    element.addEventListener(
      "change",
      () =>
        void loadExperienceActions().then((actions) =>
          actions.updateTheme(element)
        ),
    );
  });
  root.querySelectorAll("[data-setting='visual-theme']").forEach((element) => {
    element.addEventListener(
      "change",
      () =>
        void loadExperienceActions().then((actions) =>
          actions.updatePreset(element, "visualTheme")
        ),
    );
  });
  root.querySelectorAll("[data-setting='layout']").forEach((element) => {
    element.addEventListener(
      "change",
      () =>
        void loadExperienceActions().then((actions) =>
          actions.updatePreset(element, "layoutMode")
        ),
    );
  });
  root.querySelector("[data-setting='sound']")?.addEventListener(
    "change",
    (event) =>
      void loadExperienceActions().then((actions) =>
        actions.updateSound(event)
      ),
  );
  root.querySelector("[data-action='reset-settings']")?.addEventListener(
    "click",
    () => void loadExperienceActions().then((actions) => actions.reset()),
  );
  root.querySelector("[data-daily-settings-form]")?.addEventListener(
    "submit",
    (event) => void saveDailySettings(event),
  );
  const settingsMenu = root.querySelector(".settings-menu");
  settingsMenu?.addEventListener("toggle", () => {
    if (settingsMenu instanceof HTMLDetailsElement) {
      settingsOpen = settingsMenu.open;
    }
  });
  settingsMenu?.addEventListener("keydown", (event) => {
    if (event instanceof KeyboardEvent && event.key === "Escape") {
      const details = event.currentTarget;
      if (details instanceof HTMLDetailsElement) {
        details.open = false;
        details.querySelector("summary")?.focus();
      }
    }
  });
}

async function loadMore(restoreAppendedFocus = true) {
  if (!hasHiddenAssignedItems()) return;
  revealedStudyItems += 1;
  syncVisibleAssignment();
  if (!restoreAppendedFocus) {
    render();
    return;
  }
  const appended = visibleItems.at(-1);
  await renderWithTransition(
    appended ? `card-heading:${appended.candidateId}` : "cursor-restart",
    "feed-title",
  );
}

async function beginNewSession() {
  if (sessionStartPending) return;
  sessionStartPending = true;
  render("new-session", "feed-title");
  await startFeedSession();
  sessionStartPending = false;
  await renderWithTransition("new-session", "feed-title");
}

/** @param {Element} element */
async function recordPreference(element) {
  const candidateId = element.getAttribute("data-candidate-id") ?? "";
  const choice = element.getAttribute("data-preference");
  if (choice !== "more" && choice !== "less") return;
  const candidateResult = catalog.get(candidateId);
  if (!candidateResult.ok || !feedPage) {
    errorMessage = APP_COPY.preferenceSaveFailed;
    render();
    return;
  }
  const command = freeze({
    ownerId: LOCAL_OWNER_ID,
    relationshipScopeId: scopeForCandidate(candidateResult.value),
    choice,
    idempotencyKey: `preference:${feedPage.sessionId}:${candidateId}`,
    occurredAt: new Date().toISOString(),
  });
  const recorded = preferenceService.record(command);
  if (!recorded.ok) {
    notice = recorded.error.kind === "PreferenceAlreadyRecorded"
      ? "This lesson already has a preference."
      : "The preference could not be saved.";
    render();
    return;
  }
  const persisted = await appendEnvelope({
    id: command.idempotencyKey,
    ownerId: LOCAL_OWNER_ID,
    kind: "preference_event",
    payloadJson: JSON.stringify(command),
    recordedAt: command.occurredAt,
  }, false);
  if (!persisted) {
    preferenceRepository.rollback(LOCAL_OWNER_ID, command.idempotencyKey);
    notice = null;
    render();
    return;
  }
  notice = choice === "more"
    ? "Related lessons will rank higher."
    : "Related lessons will rank lower.";
  render();
}

/** @param {HTMLElement} element */
async function recordManualStudy(element) {
  const candidateId = element.getAttribute("data-candidate-id") ?? "";
  const idempotencyKey = studyKey(candidateId, 1);
  if (pendingWrites.has(idempotencyKey)) return;
  pendingWrites.add(idempotencyKey);
  element.setAttribute("disabled", "");
  const command = freeze({
    ownerId: LOCAL_OWNER_ID,
    candidateId,
    contentVersion: 1,
    idempotencyKey,
    occurredAt: new Date().toISOString(),
  });
  const recorded = await studyService.record(command);
  pendingWrites.delete(idempotencyKey);
  element.removeAttribute("disabled");
  if (!recorded.ok) {
    notice = recorded.error.kind === "StudyAlreadyRecorded"
      ? "This lesson is already studied."
      : recorded.error.kind === "StudyPersistenceFailed"
      ? "This study status could not be saved."
      : "The lesson could not be marked studied.";
    render();
    return;
  }
  notice = APP_COPY.studySaved;
  await refreshPromptAvailability();
  render(`card-heading:${candidateId}`, "feed-title");
}

/** @param {string} candidateId */
async function recordPassiveExposure(candidateId) {
  if (feedPage === null) return;
  const idempotencyKey = qualificationKey(feedPage.sessionId, candidateId);
  if (
    passiveExposureInFlight.has(idempotencyKey) ||
    exposureRepository.list(LOCAL_OWNER_ID, candidateId).some((event) =>
      event.idempotencyKey === idempotencyKey
    )
  ) {
    return;
  }
  passiveExposureInFlight.add(idempotencyKey);
  const command = freeze({
    ownerId: LOCAL_OWNER_ID,
    candidateId,
    contentVersion: 1,
    engagedMs: QUALIFIED_VIEW_MS,
    idempotencyKey,
    occurredAt: new Date().toISOString(),
  });
  const recorded = exposureService.record(command);
  if (!recorded.ok) {
    passiveExposureInFlight.delete(idempotencyKey);
    return;
  }
  const persisted = await appendEnvelope({
    id: command.idempotencyKey,
    ownerId: LOCAL_OWNER_ID,
    kind: "qualified_exposure",
    payloadJson: JSON.stringify(command),
    recordedAt: command.occurredAt,
  }, false);
  passiveExposureInFlight.delete(idempotencyKey);
  if (!persisted) {
    exposureRepository.rollback(LOCAL_OWNER_ID, command.idempotencyKey);
    renderMessagesOnly();
  }
}

/** @param {Event} event */
async function answerQuiz(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) return;
  const promptId = form.dataset.promptId ?? "";
  const candidate = candidateForPrompt(promptId);
  if (candidate === undefined || reviewResponseFromForm === null) return;
  const responseResult = reviewResponseFromForm(
    candidate.quiz,
    new FormData(form),
  );
  const feedback = form.querySelector(".answer-feedback");
  if (!responseResult.ok) {
    if (feedback) {
      feedback.textContent = "Complete the response before checking it.";
      feedback.setAttribute("role", "alert");
    }
    return;
  }
  const pendingKey = `review:${promptId}`;
  if (pendingWrites.has(pendingKey)) return;
  pendingWrites.add(pendingKey);
  const submitButton = form.querySelector('button[type="submit"]');
  if (submitButton instanceof HTMLButtonElement) submitButton.disabled = true;
  const finishSubmission = () => {
    pendingWrites.delete(pendingKey);
    if (submitButton instanceof HTMLButtonElement) {
      submitButton.disabled = false;
    }
  };
  const { LocalQuestionGrader } = await import(
    "./features/questions/grading.js"
  );
  const caseChild = caseChildForCandidate(candidate);
  const gradeResult = new LocalQuestionGrader({
    resolveQuestion: (questionId) =>
      caseChild?.id === questionId ? caseChild : null,
  }).grade(
    questionForCandidate(candidate),
    responseResult.value,
  );
  if (!gradeResult.ok) {
    finishSubmission();
    if (feedback) feedback.textContent = "The response could not be graded.";
    return;
  }
  const responseText = responseResult.value.kind === "choice"
    ? responseResult.value.selectedChoiceIds.join(",")
    : responseResult.value.kind === "case-study"
    ? responseResult.value.childResponses.map((
      /** @type {{ readonly response: Exclude<import("./features/questions/contracts.js").QuestionResponse, { readonly kind: "case-study" }> }} */ item,
    ) =>
      item.response.kind === "choice"
        ? item.response.selectedChoiceIds.join(",")
        : item.response.text
    ).join("\n")
    : responseResult.value.text;
  if (gradeResult.value.status === "review-required") {
    const recorded = await persistGradeFact({
      promptId,
      correct: null,
      finalized: false,
      status: "review-required",
      response: responseText,
      explanation: candidate.quiz.explanation,
    });
    finishSubmission();
    if (!recorded) return;
    openResponses.set(promptId, {
      response: responseText,
      explanation: candidate.quiz.explanation,
    });
    answerFeedbackByPrompt.set(promptId, {
      message: "Response saved for your review.",
      status: "review-required",
      animate: false,
    });
    reviewMode = "open";
    location.hash = "review/open";
    render("review-title", "review-title");
    return;
  }
  const correct = gradeResult.value.status === "correct";
  const finalized = await persistFinalizedRecall(promptId, correct, {
    status: gradeResult.value.status,
    response: responseText,
    explanation: candidate.quiz.explanation,
    countForDaily: scheduledPromptId === null,
  });
  finishSubmission();
  if (!finalized) return;
  answerFeedbackByPrompt.set(promptId, {
    message: correct
      ? "Correct. Review scheduled."
      : candidate.quiz.explanation,
    status: correct ? "correct" : "incorrect",
    animate: correct,
  });
  reviewFeedbackPromptId = promptId;
  render("review-title", "review-title");
  void playAnswerCue(correct);
}

/**
 * @param {string} promptId
 * @param {boolean} correct
 * @param {{ readonly status: "correct" | "incorrect", readonly response: string, readonly explanation: string, readonly countForDaily?: boolean }} detail
 */
async function persistFinalizedRecall(promptId, correct, detail) {
  if (!(await ensureRecallRuntime()) || recallService === null) return false;
  const service = recallService;
  const reviewedAt = new Date().toISOString();
  const command = freeze({
    ownerId: LOCAL_OWNER_ID,
    promptId,
    selectedChoiceId: `${promptId}-grade-${correct ? "correct" : "incorrect"}`,
    idempotencyKey: `review:${crypto.randomUUID()}`,
    reviewedAt,
  });
  const prepared = service.prepare(command);
  if (!prepared.ok) {
    errorMessage = prepared.error.kind === "RecallSchedulerUnavailable"
      ? "Review scheduling is unavailable."
      : "The answer could not be saved.";
    render();
    return false;
  }
  if (detail.countForDaily === false) {
    const eventPersisted = await appendEnvelope({
      id: command.idempotencyKey,
      ownerId: LOCAL_OWNER_ID,
      kind: "review_event",
      payloadJson: JSON.stringify(command),
      recordedAt: reviewedAt,
    }, false);
    if (!eventPersisted) return false;
  } else {
    const gradePersisted = await persistGradeFact({
      promptId,
      correct,
      finalized: true,
      recallCommand: command,
      ...detail,
    });
    if (!gradePersisted) return false;
  }
  const committed = service.commit(prepared.value);
  if (!committed.ok) {
    errorMessage = APP_COPY.answerSavedReload;
    render();
    return false;
  }
  await persistence.append({
    id:
      `memory:${prepared.value.memory.knowledgeUnitId}:${prepared.value.memory.reviewCount}`,
    ownerId: LOCAL_OWNER_ID,
    kind: "memory_state",
    payloadJson: JSON.stringify(prepared.value.memory),
    recordedAt: reviewedAt,
  });
  return true;
}

/**
 * @param {{ readonly promptId: string, readonly correct: boolean | null, readonly finalized: boolean, readonly status: "correct" | "incorrect" | "review-required", readonly response: string, readonly explanation: string, readonly recallCommand?: RecallCommand }} input
 */
async function persistGradeFact(input) {
  const membership = currentStudySets().flatMap((set) => {
    const cohort = dailyLearningRepository.getCohort(LOCAL_OWNER_ID, set.id);
    return cohort?.prompts.some((/** @type {RecallCandidateRef} */ prompt) =>
        prompt.promptId === input.promptId
      )
      ? [{ set, cohort }]
      : [];
  }).at(0);
  if (membership === undefined) {
    errorMessage = APP_COPY.promptOutsideRecall;
    render();
    return false;
  }
  const now = input.recallCommand?.reviewedAt ?? new Date().toISOString();
  const generated = promptRuntime.listPrompts(LOCAL_OWNER_ID).find((prompt) =>
    prompt.id === input.promptId
  );
  const fact = freeze({
    id: crypto.randomUUID(),
    ownerId: LOCAL_OWNER_ID,
    learningDay: currentLearningDay(),
    studySetId: membership.set.id,
    cohortId: membership.cohort.id,
    promptId: input.promptId,
    promptVersion: generated?.version ?? 1,
    respondedAt: now,
    context: /** @type {const} */ ("daily"),
    finalized: input.finalized,
    correct: input.correct,
    responseSequence: dailyResponseFacts.length + 1,
  });
  const persisted = await appendEnvelope({
    id: `grade:${fact.id}`,
    ownerId: LOCAL_OWNER_ID,
    kind: "grade_finalization",
    payloadJson: JSON.stringify({
      fact,
      status: input.status,
      response: input.response,
      explanation: input.explanation,
      recallCommand: input.recallCommand ?? null,
    }),
    recordedAt: now,
  }, false);
  if (persisted) dailyResponseFacts.push(fact);
  return persisted;
}

/** @param {Element} element */
async function finalizeOpenResponse(element) {
  const promptId = element.getAttribute("data-prompt-id") ?? "";
  const grade = element.getAttribute("data-open-grade");
  const response = openResponses.get(promptId);
  const candidate = candidateForPrompt(promptId);
  if (
    response === undefined || candidate === undefined ||
    (grade !== "correct" && grade !== "incorrect")
  ) return;
  const persisted = await persistFinalizedRecall(
    promptId,
    grade === "correct",
    {
      status: grade,
      response: response.response,
      explanation: response.explanation,
    },
  );
  if (!persisted) return;
  openResponses.delete(promptId);
  reviewFeedbackPromptId = null;
  reviewMode = openResponses.size === 0 ? "today" : "open";
  location.hash = reviewMode === "open" ? "review/open" : "review";
  render("review-title", "review-title");
}

async function exportLocalData() {
  if (!(await runLocalDataExport())) return;
  notice = APP_COPY.exported;
  render();
}

/** @returns {Promise<boolean>} */
async function runLocalDataExport() {
  const { exportLocalData: runExport } = await import(
    "./startup/user-actions.js"
  );
  const result = await runExport({
    ownerId: LOCAL_OWNER_ID,
    persistence,
    recordKinds: RECORD_KINDS,
    experienceSettings,
    now: () => new Date().toISOString(),
    document,
    url: URL,
  });
  if (!result.ok) {
    errorMessage = APP_COPY.exportFailed;
    render();
    return false;
  }
  return true;
}

async function quarantineIncompatibleReviews() {
  const recordIds = [
    ...new Set(
      incompatibleRecallRecords.map((record) => record.recordId),
    ),
  ];
  if (recordIds.length === 0 || pendingWrites.has("review-quarantine")) return;
  pendingWrites.add("review-quarantine");
  const createdAt = new Date().toISOString();
  const idempotencyKey = `review-quarantine:${crypto.randomUUID()}`;
  const recovery = await loadReviewRecovery();
  const recovered = await recovery.recover({
    ownerId: LOCAL_OWNER_ID,
    recordIds,
    idempotencyKey,
    createdAt,
    version: 1,
  });
  pendingWrites.delete("review-quarantine");
  if (!recovered.ok) {
    errorMessage = recovered.error.kind === "ReviewBackupExportFailed"
      ? APP_COPY.exportFailed
      : "Review recovery could not continue. Try again.";
    notice = null;
    render("review-title", "review-title");
  }
}

async function loadReviewRecovery() {
  if (reviewRecovery !== null) return reviewRecovery;
  const { createBrowserReviewRecovery } = await import(
    "./startup/user-actions.js"
  );
  reviewRecovery = createBrowserReviewRecovery({
    exportBackup: runLocalDataExport,
    appendEnvelope,
    location,
  });
  return reviewRecovery;
}

/** @param {EventTarget | null} target */
async function retryRoute(target) {
  if (!(target instanceof Element)) return;
  const route = target.getAttribute("data-route");
  if (route === "review") {
    reviewRouteIssue = null;
    recallRuntimeIssue = null;
    recallService = null;
  } else if (route === "library") {
    libraryRouteIssue = null;
  } else return;
  await loadActiveRoute();
  render(`${route}-title`, `${route}-title`);
}

async function resetLocalData() {
  if (!confirm("Erase all Resonance data in this browser?")) {
    return;
  }
  const { eraseLocalData } = await import("./startup/user-actions.js");
  const erased = await eraseLocalData({
    ownerId: LOCAL_OWNER_ID,
    persistence,
    settings: settingsRepository,
  });
  if (!erased.ok && erased.error.kind === "LocalDataLearningEraseFailed") {
    errorMessage = APP_COPY.eraseFailed;
    render();
    return;
  }
  if (!erased.ok) {
    alert(
      "Learning records were erased, but display settings could not be removed.",
    );
    location.reload();
    return;
  }
  location.reload();
}

/**
 * @param {PersistenceEnvelope} envelope
 * @param {boolean} allowDuplicate
 * @returns {Promise<boolean>}
 */
async function appendEnvelope(envelope, allowDuplicate) {
  const result = await persistence.append(envelope);
  if (
    !result.ok &&
    !(allowDuplicate && result.error.kind === "PersistenceDuplicate")
  ) {
    errorMessage = friendlyPersistenceError(result.error.kind);
    return false;
  }
  return true;
}

function startStudyTracking() {
  if (activeView !== "feed") return;
  const fallback = root.querySelector("[data-action='load-more']");
  if (!("IntersectionObserver" in globalThis)) {
    if (fallback instanceof HTMLButtonElement) fallback.hidden = false;
    notice = "Passive tracking is unavailable; manual study still works.";
    renderMessagesOnly();
    return;
  }
  studyObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const candidateId = entry.target.getAttribute("data-candidate-id") ?? "";
      if (
        entry.isIntersecting &&
        entry.intersectionRatio >= 0.6 &&
        !document.hidden
      ) {
        schedulePassiveExposure(candidateId);
      } else {
        cancelPassiveExposure(candidateId);
      }
    }
  }, { threshold: [0, 0.6, 1] });
  root.querySelectorAll(".learning-card").forEach((card) => {
    studyObserver?.observe(card);
  });
  const sentinel = root.querySelector("[data-feed-reveal]");
  if (sentinel === null) return;
  try {
    const observer = new IntersectionObserver((entries) => {
      if (
        feedRevealObserver !== observer ||
        !entries.some((entry) => entry.isIntersecting)
      ) return;
      observer.disconnect();
      feedRevealObserver = null;
      void loadMore(false);
    }, { rootMargin: "400px 0px" });
    feedRevealObserver = observer;
    observer.observe(sentinel);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (fallback instanceof HTMLButtonElement) fallback.hidden = false;
  }
}

/** @param {string} candidateId */
function schedulePassiveExposure(candidateId) {
  if (
    feedPage === null ||
    passiveExposureTimers.has(candidateId) ||
    exposureRepository.list(LOCAL_OWNER_ID, candidateId).some((event) =>
      event.idempotencyKey ===
        qualificationKey(feedPage?.sessionId ?? "", candidateId)
    )
  ) return;
  passiveExposureTimers.set(
    candidateId,
    setTimeout(() => {
      passiveExposureTimers.delete(candidateId);
      void recordPassiveExposure(candidateId);
    }, QUALIFIED_VIEW_MS),
  );
}

/** @param {string} candidateId */
function cancelPassiveExposure(candidateId) {
  const timer = passiveExposureTimers.get(candidateId);
  if (timer === undefined) return;
  clearTimeout(timer);
  passiveExposureTimers.delete(candidateId);
}

function cancelAllPassiveTimers() {
  for (const timer of passiveExposureTimers.values()) clearTimeout(timer);
  passiveExposureTimers.clear();
}

function stopStudyTracking() {
  cancelAllPassiveTimers();
  studyObserver?.disconnect();
  studyObserver = null;
}

function renderMessagesOnly() {
  synchronizeNotification(notifications, notice, errorMessage);
  const region = root.querySelector(".toast-region");
  if (region) {
    region.innerHTML = renderNotification(notifications.current(), escapeHtml);
  }
}

function loadExperienceSettings() {
  const loaded = settingsRepository.load();
  if (loaded.ok) {
    experienceSettings = loaded.value;
    settingsIssue = null;
    return;
  }
  experienceSettings = DEFAULT_SETTINGS;
  settingsIssue = loaded.error.kind === "SettingsMissing" ? null : loaded.error;
}

function applyExperiencePresentation() {
  const resolved = resolveTheme(
    experienceSettings.themeMode,
    systemThemeQuery.matches,
  );
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.visualTheme = experienceSettings.visualTheme;
  document.documentElement.dataset.layout = experienceSettings.layoutMode;
  document.documentElement.style.colorScheme = resolved;
  const themeMeta = document.querySelector("meta[name='theme-color']");
  if (themeMeta instanceof HTMLMetaElement) {
    themeMeta.content = getComputedStyle(document.documentElement)
      .backgroundColor;
  }
}

async function loadExperienceActions() {
  if (experienceActions !== null) return experienceActions;
  const module = await import("./startup/user-actions.js");
  experienceActions = module.createExperienceActions({
    store: settingsRepository,
    getSettings: () => experienceSettings,
    setSettings: (settings, issue) => {
      experienceSettings = settings;
      settingsIssue = issue;
    },
    defaultSettings: DEFAULT_SETTINGS,
    visualThemes: VISUAL_THEMES,
    layouts: LAYOUTS,
    applyPresentation: applyExperiencePresentation,
    transitions,
    reducedMotion: () => reducedMotionQuery.matches,
    render,
    playInteractionCue: () => void playInteractionCue(),
  });
  return experienceActions;
}

/** @param {Event} event */
async function saveDailySettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement) || dailySettings === null) return;
  const data = new FormData(form);
  const target = Number(data.get("daily-study-target"));
  const limit = Number(data.get("daily-recall-limit"));
  const result = dailyLearningService.saveSettings({
    ownerId: LOCAL_OWNER_ID,
    dailyStudyTarget: target,
    dailyRecallLimit: limit,
    timeZone: dailySettings.timeZone,
    expectedRevision: dailySettings.revision,
    updatedAt: new Date().toISOString(),
  });
  if (!result.ok) {
    const error = form.querySelector("[data-daily-settings-error]");
    if (error instanceof HTMLElement) {
      error.textContent = result.error.kind === "DailyTargetPairInvalid"
        ? "Recall limit must be lower than the study target."
        : "Use a 1-50 study target and a non-negative recall limit.";
      error.focus();
    }
    return;
  }
  if (!(await commitDailySettings(result.value))) return;
  notice = APP_COPY.targetsSaved;
  render("settings-summary", null);
}

async function addDailyStudySet() {
  if (dailySettings === null || feedPage === null) return;
  await refreshPromptAvailability();
  const sets = currentStudySets();
  const latest = sets.at(-1);
  if (latest === undefined) return;
  const cohort = dailyLearningRepository.getCohort(LOCAL_OWNER_ID, latest.id);
  if (cohort === null && latest.recallLimit > 0) {
    notice = APP_COPY.finishRecall;
    render();
    return;
  }
  const gate = dailyLearningService.evaluateNextSet({
    ownerId: LOCAL_OWNER_ID,
    studySetId: latest.id,
    studiedContentIds: studiedContentIds(),
    finalizedPromptIds: new Set(
      dailyResponseFacts.filter((fact) => fact.finalized).map((fact) =>
        fact.promptId
      ),
    ),
  });
  if (!gate.ok) {
    notice = gate.error.kind === "NextStudySetLocked"
      ? `Complete ${gate.error.remainingStudy} study items and ${gate.error.remainingRecall} prompts first.`
      : "Another set cannot be assigned yet.";
    render();
    return;
  }
  const now = new Date().toISOString();
  const ordinal = sets.length + 1;
  const created = dailyLearningService.createStudySet({
    ownerId: LOCAL_OWNER_ID,
    learningDay: currentLearningDay(),
    idempotencyKey:
      `daily-set:${LOCAL_OWNER_ID}:${currentLearningDay()}:${ordinal}`,
    createdAt: now,
    candidates: feedPage.items.map((/** @type {RankedFeedItem} */ item) => {
      const candidate = candidates.find((entry) =>
        entry.id === item.candidateId
      );
      return {
        contentId: item.candidateId,
        contentVersion: 1,
        promptIds: candidate === undefined ? [] : [candidate.quiz.id],
      };
    }),
  });
  if (!created.ok) {
    notice = created.error.kind === "DailyAssignmentInsufficientCandidates"
      ? `No partial set: ${created.error.available} unused items; ${created.error.required} required.`
      : "Another set could not be created.";
    render();
    return;
  }
  if (!(await commitStudySet(created.value))) return;
  if (!(await issueRecallCohort(created.value))) return;
  revealedStudyItems += 1;
  syncVisibleAssignment();
  render(`card-heading:${created.value.items[0].contentId}`, "feed-title");
}

/** @param {boolean} correct */
async function playAnswerCue(correct) {
  const service = correct ? correctAudio : incorrectAudio;
  await playFeedbackCue(service);
}

async function playInteractionCue() {
  await playFeedbackCue(interactionAudio);
}

/** @param {FeedbackAudioService} service */
async function playFeedbackCue(service) {
  const played = await service.playCue({
    enabled: experienceSettings.soundEnabled,
    explicitActivation: true,
  });
  if (played.ok || played.error.kind === "AudioActivationRequired") return;
  const disabled = freeze({
    ...experienceSettings,
    soundEnabled: false,
  });
  const saved = settingsRepository.save(disabled);
  if (saved.ok) {
    experienceSettings = saved.value;
  } else {
    settingsIssue = saved.error;
  }
  const soundToggle = root.querySelector("[data-setting='sound']");
  if (soundToggle instanceof HTMLInputElement) soundToggle.checked = false;
  notice = APP_COPY.soundsUnavailable;
  renderMessagesOnly();
}

/**
 * @param {string | null} focusKey
 * @param {string | null} fallbackHeadingId
 */
async function renderWithTransition(focusKey, fallbackHeadingId) {
  await applyPresentationUpdate({
    update: () => render(focusKey, fallbackHeadingId),
    transitions,
    reducedMotion: reducedMotionQuery.matches,
  });
}

/** @param {string | null} focusKey @param {string | null} headingId */
function restoreFocus(focusKey, headingId) {
  const escapedKey = focusKey === null ? null : CSS.escape(focusKey);
  const preferred = escapedKey === null
    ? null
    : root.querySelector(`[data-focus-key="${escapedKey}"]`);
  if (preferred instanceof HTMLElement) {
    preferred.focus();
    if (document.activeElement === preferred) return;
  }
  const heading = headingId === null
    ? null
    : document.getElementById(headingId);
  if (heading instanceof HTMLElement) {
    heading.tabIndex = -1;
    heading.focus();
    if (document.activeElement === heading) return;
  }
  if (focusKey !== null || headingId !== null) {
    const workspace = root.querySelector("#main-content");
    if (workspace instanceof HTMLElement) workspace.focus();
  }
}

/** @param {string} candidateId */
function focusLessonHeading(candidateId) {
  const heading = root.querySelector(
    `[data-focus-key="card-heading:${CSS.escape(candidateId)}"]`,
  );
  if (heading instanceof HTMLElement) heading.focus();
}

function registerOfflineSupport() {
  addEventListener("online", () => render());
  addEventListener("offline", () => render());
  systemThemeQuery.addEventListener("change", () => {
    if (experienceSettings.themeMode !== "system") return;
    void applyPresentationUpdate({
      update: () => {
        applyExperiencePresentation();
      },
      transitions,
      reducedMotion: reducedMotionQuery.matches,
    });
  });
  document.addEventListener("visibilitychange", () => {
    cancelAllPassiveTimers();
    if (!document.hidden) {
      studyObserver?.disconnect();
      studyObserver = null;
      startStudyTracking();
      void refreshPromptAvailability().then(() => render());
    }
  });
  addEventListener("hashchange", () => {
    const route = parseRoute(location.hash);
    activeView = route.view;
    libraryPage = route.libraryPage;
    reviewMode = route.reviewMode;
    scheduledPromptId = route.scheduledPromptId;
    discoveryItemId = route.discoveryItemId;
    void loadActiveRoute().then(() =>
      renderWithTransition(
        `nav-${route.view}`,
        route.view === "feed" ? "feed-title" : `${route.view}-title`,
      )
    );
  });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (!isOfflineFailureMessage(event.data)) return;
      showOfflineFailure(event.data.kind);
    });
    navigator.serviceWorker.register("./service-worker.js")
      .then(watchServiceWorkerInstall)
      .catch(() => showOfflineFailure("OfflineRegistrationFailed"));
  }
}

/** @param {ServiceWorkerRegistration} registration */
function watchServiceWorkerInstall(registration) {
  observeInstallingWorker(
    registration.installing,
    navigator.serviceWorker.controller !== null,
  );
  registration.addEventListener("updatefound", () => {
    observeInstallingWorker(
      registration.installing,
      navigator.serviceWorker.controller !== null,
    );
  });
}

/** @param {ServiceWorker | null} installing @param {boolean} isUpgrade */
function observeInstallingWorker(installing, isUpgrade) {
  if (installing === null) return;
  installing.addEventListener("statechange", () => {
    if (installing.state !== "redundant") return;
    showOfflineFailure(
      isUpgrade ? "OfflineUpgradeFailed" : "OfflineCacheInstallFailed",
    );
  });
}

/**
 * @param {"OfflineRegistrationFailed" | "OfflineCacheInstallFailed" | "OfflineUpgradeFailed" | "OfflineCacheMiss"} kind
 */
function showOfflineFailure(kind) {
  errorMessage = friendlyOfflineFailure(kind);
  renderMessagesOnly();
}

/**
 * @param {unknown} value
 * @returns {value is {
 *   readonly type: "resonance-offline-failure",
 *   readonly kind: "OfflineCacheInstallFailed" | "OfflineUpgradeFailed" | "OfflineCacheMiss"
 * }}
 */
function isOfflineFailureMessage(value) {
  if (!isRecord(value) || value.type !== "resonance-offline-failure") {
    return false;
  }
  return value.kind === "OfflineCacheInstallFailed" ||
    value.kind === "OfflineUpgradeFailed" ||
    value.kind === "OfflineCacheMiss";
}

/** @param {CatalogCandidate} candidate */
function scopeForCandidate(candidate) {
  return `related:${candidate.knowledgeUnitIds.join("+")}`;
}

function currentStudySets() {
  if (dailySettings === null) return [];
  return dailyLearningRepository.listStudySets(
    LOCAL_OWNER_ID,
    learningDay(dailySettings.timeZone),
  );
}

function studiedContentIds() {
  return new Set(
    candidates.flatMap((candidate) =>
      studyRepository.list(LOCAL_OWNER_ID, candidate.id).length > 0
        ? [candidate.id]
        : []
    ),
  );
}

function hasHiddenAssignedItems() {
  const assigned = currentStudySets().reduce(
    (total, set) => total + set.items.length,
    0,
  );
  return revealedStudyItems < assigned;
}

function renderNextSetControl() {
  const latest = currentStudySets().at(-1);
  if (latest === undefined) return "<p>No set is assigned.</p>";
  const cohort = dailyLearningRepository.getCohort(LOCAL_OWNER_ID, latest.id);
  if (cohort === null && latest.recallLimit > 0) {
    return "<p><strong>Study set complete.</strong> Recall unlocks ten minutes after study.</p>";
  }
  const gate = dailyLearningService.evaluateNextSet({
    ownerId: LOCAL_OWNER_ID,
    studySetId: latest.id,
    studiedContentIds: studiedContentIds(),
    finalizedPromptIds: new Set(
      dailyResponseFacts.filter((fact) => fact.finalized).map((fact) =>
        fact.promptId
      ),
    ),
  });
  if (!gate.ok && gate.error.kind === "NextStudySetLocked") {
    return `<p><strong>Set in progress.</strong> ${gate.error.remainingStudy} study items and ${gate.error.remainingRecall} prompts remain.</p>`;
  }
  return `<button class="button secondary" type="button" data-action="add-study-set">Add another set</button>`;
}

/** @param {string} candidateId */
function recallAvailableAt(candidateId) {
  const event = studyRepository.list(LOCAL_OWNER_ID, candidateId).at(0);
  return event === undefined
    ? new Date().toISOString()
    : new Date(Date.parse(event.occurredAt) + 10 * 60_000).toISOString();
}

function currentLearningDay() {
  return learningDay(
    dailySettings?.timeZone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
}

/** @param {string} timeZone */
function learningDay(timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

/** @param {string} day @param {number} count */
function subtractLearningDays(day, count) {
  const [year, month, date] = day.split("-").map(Number);
  if (
    !Number.isInteger(year) || !Number.isInteger(month) ||
    !Number.isInteger(date) || !Number.isInteger(count) || count < 0
  ) {
    throw new TypeError("LearningDayDateInvalid");
  }
  return new Date(Date.UTC(year, month - 1, date) - count * 86_400_000)
    .toISOString().slice(0, 10);
}

/** @param {string} promptId @returns {CatalogCandidate | undefined} */
function candidateForPrompt(promptId) {
  const direct = candidates.find((candidate) => candidate.quiz.id === promptId);
  if (direct !== undefined) return direct;
  const generated = promptRuntime.listPrompts(LOCAL_OWNER_ID).find((prompt) =>
    prompt.id === promptId
  );
  if (generated === undefined) return undefined;
  const source = candidates.find((candidate) =>
    candidate.id === generated.contentId
  );
  if (source === undefined) return undefined;
  return freeze({
    ...source,
    quiz: freeze({
      ...source.quiz,
      id: generated.id,
      prompt: generated.prompt,
      version: generated.version,
    }),
  });
}

/**
 * @param {CatalogCandidate} candidate
 * @returns {import("./features/questions/contracts.js").Question}
 */
function questionForCandidate(candidate) {
  const quiz = candidate.quiz;
  const metadata = {
    contentId: candidate.id,
    contentVersion: 1,
    knowledgeUnitIds:
      /** @type {[string, ...string[]]} */ ([...candidate.knowledgeUnitIds]),
    sourceAnchorIds:
      /** @type {[string, ...string[]]} */ ([...candidate.knowledgeUnitIds]),
    generatorVersion: "fixture-generator-v2",
    version: quiz.version,
    scorerVersion: quiz.kind === "free-response" || quiz.kind === "case-study"
      ? "local-concept-v1"
      : "local-exact-v1",
    provenance: "fixture-generator",
  };
  if (quiz.kind === "single-choice" || quiz.kind === "multiple-choice") {
    const choices = quiz.choices.map((
      /** @type {string} */ label,
      /** @type {number} */ index,
    ) => ({
      id: String(index),
      label,
    }));
    return /** @type {import("./features/questions/contracts.js").Question} */ ({
      id: quiz.id,
      prompt: quiz.prompt,
      kind: quiz.kind,
      choices,
      correctChoiceIds: quiz.correctChoices.map(String),
      explanation: quiz.explanation,
      ...metadata,
    });
  }
  if (quiz.kind === "fill-blank") {
    return {
      id: quiz.id,
      prompt: quiz.prompt,
      kind: quiz.kind,
      blankId: `${quiz.id}:blank-1`,
      acceptedAnswers:
        /** @type {[string, ...string[]]} */ ([...quiz.acceptedAnswers]),
      explanation: quiz.explanation,
      ...metadata,
    };
  }
  if (quiz.kind === "case-study") {
    return {
      id: quiz.id,
      prompt: quiz.prompt,
      kind: quiz.kind,
      stimulus: quiz.stimulus ?? "",
      childQuestionIds:
        /** @type {[string, ...string[]]} */ ([`${quiz.id}:response`]),
      explanation: quiz.explanation,
      ...metadata,
    };
  }
  return {
    id: quiz.id,
    prompt: quiz.prompt,
    kind: /** @type {const} */ ("free-response"),
    expectedConcepts:
      /** @type {[string, ...string[]]} */ ([...quiz.expectedConcepts]),
    minimumWords: quiz.minimumWords,
    explanation: quiz.explanation,
    ...metadata,
  };
}

/** @param {CatalogCandidate} candidate */
function caseChildForCandidate(candidate) {
  const quiz = candidate.quiz;
  if (quiz.kind !== "case-study") return null;
  return freeze({
    id: `${quiz.id}:response`,
    prompt: quiz.prompt,
    kind: /** @type {const} */ ("free-response"),
    expectedConcepts:
      /** @type {[string, ...string[]]} */ ([...quiz.expectedConcepts]),
    minimumWords: quiz.minimumWords,
    explanation: quiz.explanation,
    contentId: candidate.id,
    contentVersion: 1,
    knowledgeUnitIds:
      /** @type {[string, ...string[]]} */ ([...candidate.knowledgeUnitIds]),
    sourceAnchorIds:
      /** @type {[string, ...string[]]} */ ([...candidate.knowledgeUnitIds]),
    generatorVersion: "fixture-generator-v2",
    version: quiz.version,
    scorerVersion: "local-concept-v1",
    provenance: "fixture-generator",
  });
}

/** @param {string} sessionId @param {string} candidateId */
function qualificationKey(sessionId, candidateId) {
  return `exposure:${LOCAL_OWNER_ID}:${sessionId}:${candidateId}:v1`;
}

/** @param {string} candidateId @param {number} contentVersion */
function studyKey(candidateId, contentVersion) {
  return `study:${LOCAL_OWNER_ID}:${candidateId}:v${contentVersion}`;
}

/** @param {string} sessionId @param {string} candidateId */
function preferencePromptKey(sessionId, candidateId) {
  return `${sessionId}\u0000${candidateId}`;
}

/** @param {string} hash */
function parseRoute(hash) {
  const [view, section, rawPromptId] = hash.replace(/^#/, "").split("/");
  let scheduledPromptId = null;
  let discoveryItemId = null;
  if (view === "review" && section === "scheduled" && rawPromptId) {
    try {
      scheduledPromptId = decodeURIComponent(rawPromptId);
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
      scheduledPromptId = null;
    }
  }
  if (view === "discover" && section === "item" && rawPromptId) {
    try {
      discoveryItemId = decodeURIComponent(rawPromptId);
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
      discoveryItemId = null;
    }
  }
  return {
    view: view === "discover" || view === "review" || view === "library"
      ? view
      : "feed",
    libraryPage: view === "library" && section === "review-queue"
      ? /** @type {const} */ ("review-queue")
      : /** @type {const} */ ("collection"),
    reviewMode: view === "review" && section === "open"
      ? /** @type {const} */ ("open")
      : /** @type {const} */ ("today"),
    scheduledPromptId,
    discoveryItemId,
  };
}

/** @param {"feed" | "discover" | "review" | "library"} view @param {string} label */
function navButton(view, label) {
  const active = activeView === view;
  return `
    <button type="button" data-view="${view}" data-focus-key="nav-${view}" class="${
    active ? "active" : ""
  }" ${active ? 'aria-current="page"' : ""}>
      ${label}
    </button>
  `;
}

/** @param {string} elementId @returns {unknown} */
function readEmbeddedJson(elementId) {
  const element = document.getElementById(elementId);
  if (!(element instanceof HTMLScriptElement)) {
    throw new TypeError(`EmbeddedDataMissing:${elementId}`);
  }
  try {
    return /** @type {unknown} */ (JSON.parse(element.textContent ?? ""));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new TypeError(`EmbeddedDataMalformed:${elementId}`);
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/** @param {string} value */
function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    })[character] ?? character);
}

/** @param {number} affinity */
function formatAffinity(affinity) {
  if (affinity > 0) return `+${affinity.toFixed(2)}`;
  return affinity.toFixed(2);
}

/** @param {string} value */
function formatDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "invalid date";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** @param {string} kind */
function friendlyFailure(kind) {
  if (kind === "CursorExpired") {
    return APP_COPY.feedExpired;
  }
  if (kind === "FeedSessionMissing") {
    return APP_COPY.feedUnavailable;
  }
  if (kind === "InvalidPageLimit") {
    return APP_COPY.pageSizeUnsupported;
  }
  if (kind === "CursorMalformed") {
    return APP_COPY.cursorInvalid;
  }
  if (kind === "CursorOwnerMismatch") {
    return APP_COPY.feedOwnerMismatch;
  }
  if (kind === "CursorSessionMismatch") {
    return APP_COPY.pageMismatch;
  }
  if (kind === "CandidateUnavailable" || kind === "CandidateSourceDisabled") {
    return APP_COPY.lessonUnavailable;
  }
  return APP_COPY.feedOpenFailed;
}

/** @param {string} kind */
function friendlyPersistenceError(kind) {
  if (kind === "PersistenceUnavailable") {
    return APP_COPY.storageUnavailable;
  }
  return APP_COPY.learningDataUnavailable;
}

/**
 * @param {{ readonly kind: "LocalStateReadFailed", readonly persistenceKind: import("./persistence/contracts.js").PersistenceFailure["kind"] } | { readonly kind: "LocalStateCorrupt", readonly recordKind: RecordKind, readonly recordId: string }} failure
 * @returns {{ readonly kind: "LocalStateReadFailed" | "LocalStateCorrupt", readonly message: string }}
 */
function restoreRecoveryFor(failure) {
  if (failure.kind === "LocalStateReadFailed") {
    return freeze({
      kind: failure.kind,
      message: friendlyPersistenceError(failure.persistenceKind),
    });
  }
  return freeze({
    kind: failure.kind,
    message:
      "Resonance could not safely open part of this browser's saved learning data.",
  });
}

/** @param {string} kind */
function friendlyOfflineFailure(kind) {
  if (kind === "OfflineCacheMiss") {
    return APP_COPY.offlineMiss;
  }
  if (kind === "OfflineUpgradeFailed") {
    return APP_COPY.offlineUpgrade;
  }
  return APP_COPY.offlineFailed;
}

/** @param {string} kind */
function friendlySettingsFailure(kind) {
  if (kind === "SettingsReadUnavailable") {
    return APP_COPY.settingsRead;
  }
  if (kind === "SettingsWriteUnavailable") {
    return APP_COPY.settingsWrite;
  }
  if (kind === "SettingsEraseUnavailable") {
    return APP_COPY.settingsReset;
  }
  return APP_COPY.settingsInvalid;
}

/** @returns {import("./features/experience/contracts.js").SettingsStorage} */
function resolveSettingsStorage() {
  try {
    return window.localStorage;
  } catch {
    const unavailable = () => {
      throw new DOMException("Storage unavailable", "InvalidStateError");
    };
    return {
      getItem() {
        unavailable();
        return null;
      },
      setItem() {
        unavailable();
      },
      removeItem() {
        unavailable();
      },
    };
  }
}

/** @param {Document} targetDocument @returns {ViewTransitionCapability | null} */
function resolveTransitionCapability(targetDocument) {
  const capableDocument = /** @type {Document & {
    startViewTransition?: (update: () => void) => import("./features/experience/contracts.js").ViewTransitionHandle
  }} */
    (targetDocument);
  const start = capableDocument.startViewTransition?.bind(capableDocument);
  return start === undefined ? null : { start };
}

/** @returns {(() => AudioContextPort) | null} */
function resolveAudioContextFactory() {
  if (typeof AudioContext !== "function") return null;
  return () => /** @type {AudioContextPort} */ (
    /** @type {unknown} */ (new AudioContext())
  );
}
