// @ts-check

/** @import { CatalogCandidate } from "./contracts.js" */

/**
 * This is explicit demo data. Reusable catalog logic does not recognize these
 * values or infer source identity from them.
 *
 * @type {readonly CatalogCandidate[]}
 */
export const catalogFixtures = Object.freeze([
  Object.freeze({
    id: "fixture-listening-001",
    librarySourceId: null,
    title: "Why suspensions create forward motion",
    publisher: "Resonance Fixture Studio",
    summary:
      "Hear how preparation, dissonance, and resolution shape expectation, then connect the pattern to voice leading.",
    durationLabel: "8 min",
    formatLabel: "Podcast lesson",
    artworkPath: "./assets/suspension-study.webp",
    artworkCompactPath: "./assets/suspension-study-640.webp",
    artworkWidth: 1280,
    artworkHeight: 721,
    artworkCompactWidth: 640,
    knowledgeUnitIds: Object.freeze([
      "fixture-knowledge-suspension",
      "fixture-knowledge-voice-leading",
    ]),
    discovery: Object.freeze({
      method: "fixture",
      retrievedAt: "2026-07-19T00:00:00.000Z",
      sourceLabel: "Rights-safe project fixture",
      canonicalUrl: "https://example.invalid/resonance-fixtures/suspensions",
    }),
    rights: Object.freeze({
      basis:
        "Project-authored fixture permitted for display and transformation",
      attributionRequired: true,
      displayPermitted: true,
      transformationPermitted: true,
    }),
    quiz: Object.freeze({
      id: "fixture-quiz-001",
      prompt: "What makes a suspension feel directed toward its resolution?",
      kind: /** @type {const} */ ("single-choice"),
      choices: Object.freeze([
        "A prepared dissonance resolves by step",
        "Every voice repeats the same pitch",
        "The tempo increases before the cadence",
      ]),
      correctChoices: Object.freeze([0]),
      acceptedAnswers: Object.freeze([]),
      expectedConcepts: Object.freeze([]),
      minimumWords: 0,
      stimulus: null,
      explanation:
        "The held note is prepared as a consonance, becomes dissonant against the new harmony, and resolves by step.",
      version: 1,
    }),
  }),
  Object.freeze({
    id: "fixture-sound-002",
    librarySourceId: null,
    title: "How filter resonance reshapes a sound",
    publisher: "Resonance Fixture Studio",
    summary:
      "Trace a low-pass filter across a harmonic spectrum and hear why a resonance peak makes the cutoff frequency more prominent.",
    durationLabel: "6 min",
    formatLabel: "Sound design lesson",
    artworkPath: "./assets/filter-spectrum.webp",
    artworkCompactPath: "./assets/filter-spectrum-640.webp",
    artworkWidth: 1280,
    artworkHeight: 721,
    artworkCompactWidth: 640,
    knowledgeUnitIds: Object.freeze([
      "fixture-knowledge-filter-cutoff",
      "fixture-knowledge-resonance",
    ]),
    discovery: Object.freeze({
      method: "fixture",
      retrievedAt: "2026-07-19T00:00:00.000Z",
      sourceLabel: "Rights-safe project fixture",
      canonicalUrl:
        "https://example.invalid/resonance-fixtures/filter-resonance",
    }),
    rights: Object.freeze({
      basis:
        "Project-authored fixture permitted for display and transformation",
      attributionRequired: true,
      displayPermitted: true,
      transformationPermitted: true,
    }),
    quiz: Object.freeze({
      id: "fixture-quiz-002",
      prompt: "Increasing resonance emphasizes frequencies close to the ___.",
      kind: /** @type {const} */ ("fill-blank"),
      choices: Object.freeze([]),
      correctChoices: Object.freeze([]),
      acceptedAnswers: Object.freeze(["cutoff", "cutoff frequency"]),
      expectedConcepts: Object.freeze([]),
      minimumWords: 0,
      stimulus: null,
      explanation:
        "Resonance creates a peak around the cutoff frequency, emphasizing that region before higher frequencies are attenuated.",
      version: 1,
    }),
  }),
  Object.freeze({
    id: "fixture-rhythm-003",
    librarySourceId: null,
    title: "Hearing rhythmic displacement against the pulse",
    publisher: "Resonance Fixture Studio",
    summary:
      "Follow a repeating accent pattern as it shifts against a steady grid, creating syncopation without changing the underlying tempo.",
    durationLabel: "7 min",
    formatLabel: "Rhythm analysis",
    artworkPath: "./assets/rhythmic-displacement.webp",
    artworkCompactPath: "./assets/rhythmic-displacement-640.webp",
    artworkWidth: 1280,
    artworkHeight: 721,
    artworkCompactWidth: 640,
    knowledgeUnitIds: Object.freeze([
      "fixture-knowledge-syncopation",
      "fixture-knowledge-metric-displacement",
    ]),
    discovery: Object.freeze({
      method: "fixture",
      retrievedAt: "2026-07-19T00:00:00.000Z",
      sourceLabel: "Rights-safe project fixture",
      canonicalUrl:
        "https://example.invalid/resonance-fixtures/rhythmic-displacement",
    }),
    rights: Object.freeze({
      basis:
        "Project-authored fixture permitted for display and transformation",
      attributionRequired: true,
      displayPermitted: true,
      transformationPermitted: true,
    }),
    quiz: Object.freeze({
      id: "fixture-quiz-003",
      prompt: "Which statements describe rhythmic displacement?",
      kind: /** @type {const} */ ("multiple-choice"),
      choices: Object.freeze([
        "The underlying pulse",
        "The accent pattern shifts against the grid",
        "The tempo must accelerate",
      ]),
      correctChoices: Object.freeze([0, 1]),
      acceptedAnswers: Object.freeze([]),
      expectedConcepts: Object.freeze([]),
      minimumWords: 0,
      stimulus: null,
      explanation:
        "The pulse remains stable while the repeating accent pattern begins at a different position against it.",
      version: 1,
    }),
  }),
  Object.freeze({
    id: "fixture-harmony-004",
    librarySourceId: null,
    title: "Tracing tonic function through a phrase",
    publisher: "Resonance Fixture Studio",
    summary:
      "Connect harmonic stability, departure, and return to the tonic function across a compact phrase.",
    durationLabel: "5 min",
    formatLabel: "Harmony note",
    artworkPath: "./assets/suspension-study.webp",
    artworkCompactPath: "./assets/suspension-study-640.webp",
    artworkWidth: 1280,
    artworkHeight: 721,
    artworkCompactWidth: 640,
    knowledgeUnitIds: Object.freeze([
      "fixture-knowledge-tonic-function",
      "fixture-knowledge-harmonic-stability",
    ]),
    discovery: Object.freeze({
      method: "fixture",
      retrievedAt: "2026-07-19T00:00:00.000Z",
      sourceLabel: "Rights-safe project fixture",
      canonicalUrl: "https://example.invalid/resonance-fixtures/tonic-function",
    }),
    rights: Object.freeze({
      basis:
        "Project-authored fixture permitted for display and transformation",
      attributionRequired: true,
      displayPermitted: true,
      transformationPermitted: true,
    }),
    quiz: Object.freeze({
      id: "fixture-quiz-004",
      prompt: "Explain why tonic function feels stable in a tonal phrase.",
      kind: /** @type {const} */ ("free-response"),
      choices: Object.freeze([]),
      correctChoices: Object.freeze([]),
      acceptedAnswers: Object.freeze([]),
      expectedConcepts: Object.freeze(["tonal center", "resolution"]),
      minimumWords: 5,
      stimulus: null,
      explanation:
        "A strong response connects tonic to the tonal center and the resolution of harmonic tension.",
      version: 1,
    }),
  }),
  Object.freeze({
    id: "fixture-production-005",
    librarySourceId: null,
    title: "Choosing headroom before a mix bus",
    publisher: "Resonance Fixture Studio",
    summary:
      "Compare peak level and perceived loudness while leaving practical headroom for later processing.",
    durationLabel: "6 min",
    formatLabel: "DAW case study",
    artworkPath: "./assets/filter-spectrum.webp",
    artworkCompactPath: "./assets/filter-spectrum-640.webp",
    artworkWidth: 1280,
    artworkHeight: 721,
    artworkCompactWidth: 640,
    knowledgeUnitIds: Object.freeze([
      "fixture-knowledge-headroom",
      "fixture-knowledge-gain-staging",
    ]),
    discovery: Object.freeze({
      method: "fixture",
      retrievedAt: "2026-07-19T00:00:00.000Z",
      sourceLabel: "Rights-safe project fixture",
      canonicalUrl: "https://example.invalid/resonance-fixtures/headroom",
    }),
    rights: Object.freeze({
      basis:
        "Project-authored fixture permitted for display and transformation",
      attributionRequired: true,
      displayPermitted: true,
      transformationPermitted: true,
    }),
    quiz: Object.freeze({
      id: "fixture-quiz-005",
      prompt: "Recommend a gain-staging adjustment and justify it.",
      kind: /** @type {const} */ ("case-study"),
      choices: Object.freeze([]),
      correctChoices: Object.freeze([]),
      acceptedAnswers: Object.freeze([]),
      expectedConcepts: Object.freeze(["peak level", "headroom"]),
      minimumWords: 7,
      stimulus:
        "A channel peaks near 0 dBFS before it reaches a compressor and the mix bus.",
      explanation:
        "Reduce the channel level so peak level leaves headroom for processing without changing the musical balance.",
      version: 1,
    }),
  }),
]);
