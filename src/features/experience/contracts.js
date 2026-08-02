// @ts-check

/**
 * @template T
 * @template E
 * @typedef {{ readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: E }} Result
 */

/** @typedef {"system" | "light" | "dark"} ThemeMode */
/** @typedef {"light" | "dark"} ResolvedTheme */
/** @typedef {"studio-signal" | "collection-index" | "learning-pulse"} VisualTheme */
/** @typedef {"guided-stack" | "split-desk" | "compact-index"} LayoutMode */

/**
 * @typedef {{
 *   readonly schemaVersion: 2,
 *   readonly themeMode: ThemeMode,
 *   readonly visualTheme: VisualTheme,
 *   readonly layoutMode: LayoutMode,
 *   readonly soundEnabled: boolean
 * }} ExperienceSettings
 */

/**
 * @typedef {{ readonly kind: "SettingsMissing" }
 * | { readonly kind: "SettingsReadUnavailable" }
 * | { readonly kind: "SettingsMalformed", readonly field: string }
 * | { readonly kind: "SettingsVersionUnsupported", readonly version: number }
 * | { readonly kind: "SettingsThemeUnknown", readonly themeId: string }
 * | { readonly kind: "SettingsLayoutUnknown", readonly layoutId: string }
 * | { readonly kind: "SettingsMigrationFailed", readonly fromVersion: 1, readonly toVersion: 2 }
 * | { readonly kind: "SettingsWriteUnavailable" }
 * | { readonly kind: "SettingsEraseUnavailable" }} SettingsFailure
 */

/**
 * @template {string} T
 * @typedef {{
 *   readonly id: T,
 *   readonly label: string,
 *   readonly source: string
 * }} ExperiencePreset
 */

/**
 * A minimal synchronous storage boundary compatible with Web Storage.
 *
 * @typedef {{
 *   getItem(key: string): string | null,
 *   setItem(key: string, value: string): void,
 *   removeItem(key: string): void
 * }} SettingsStorage
 */

/**
 * @typedef {{
 *   readonly storage: SettingsStorage,
 *   readonly key: string,
 *   readonly ownerId: string,
 *   readonly visualThemes: readonly ExperiencePreset<VisualTheme>[],
 *   readonly layouts: readonly ExperiencePreset<LayoutMode>[],
 *   readonly defaultVisualTheme: VisualTheme,
 *   readonly defaultLayoutMode: LayoutMode
 * }} SettingsRepositoryDependencies
 */

/**
 * @typedef {{ readonly kind: "AudioUnsupported" }
 * | { readonly kind: "AudioActivationRequired" }
 * | { readonly kind: "AudioResumeFailed" }
 * | { readonly kind: "AudioPlaybackFailed" }} AudioFailure
 */

/**
 * @typedef {{
 *   setValueAtTime(value: number, startTime: number): AudioParamPort,
 *   exponentialRampToValueAtTime(value: number, endTime: number): AudioParamPort
 * }} AudioParamPort
 */

/**
 * @typedef {{
 *   readonly frequency: AudioParamPort,
 *   readonly type: OscillatorType,
 *   connect(destination: unknown): unknown,
 *   start(when?: number): void,
 *   stop(when?: number): void
 * }} OscillatorPort
 */

/**
 * @typedef {{
 *   readonly gain: AudioParamPort,
 *   connect(destination: unknown): unknown
 * }} GainPort
 */

/**
 * @typedef {{
 *   readonly state: AudioContextState,
 *   readonly currentTime: number,
 *   readonly destination: unknown,
 *   resume(): Promise<void>,
 *   createOscillator(): OscillatorPort,
 *   createGain(): GainPort
 * }} AudioContextPort
 */

/** @typedef {() => AudioContextPort} AudioContextFactory */

/**
 * @typedef {{
 *   readonly frequencyHz: number,
 *   readonly durationSeconds: number,
 *   readonly peakGain: number,
 *   readonly oscillatorType: OscillatorType
 * }} AudioCue
 */

/**
 * @typedef {{
 *   readonly enabled: boolean,
 *   readonly explicitActivation: boolean
 * }} PlayCueCommand
 */

/** @typedef {{ readonly kind: "SoundDisabled" } | { readonly kind: "CuePlayed" }} AudioOutcome */

/**
 * @typedef {{ readonly kind: "ProgressInputInvalid", readonly field: string }
 * | { readonly kind: "ProgressOutOfBounds", readonly studied: number, readonly shown: number }} ProgressFailure
 */

/**
 * @typedef {{
 *   readonly studied: number,
 *   readonly shown: number,
 *   readonly ratio: number,
 *   readonly label: string
 * }} ShownProgress
 */

/**
 * @typedef {{
 *   readonly candidateId: string,
 *   readonly dueAt: string | null
 * }} DueCandidate
 */

/**
 * @typedef {{ readonly kind: "TransitionUnavailable", readonly reason: "unsupported" | "reduced-motion" }
 * | { readonly kind: "TransitionStartFailed" }
 * | { readonly kind: "TransitionCompletionFailed" }} MotionFailure
 */

/**
 * @typedef {{
 *   readonly ready?: Promise<void>,
 *   readonly updateCallbackDone?: Promise<void>,
 *   readonly finished: Promise<void>
 * }} ViewTransitionHandle
 */

/**
 * @typedef {{
 *   start(update: () => void): ViewTransitionHandle
 * }} ViewTransitionCapability
 */

/**
 * @typedef {{ readonly kind: "TransitionApplied" }
 * | { readonly kind: "TransitionFallbackApplied", readonly error: Extract<MotionFailure, { kind: "TransitionUnavailable" | "TransitionStartFailed" }> }
 * | { readonly kind: "TransitionAppliedWithCompletionFailure", readonly error: Extract<MotionFailure, { kind: "TransitionCompletionFailed" }> }} MotionOutcome
 */

export {};
