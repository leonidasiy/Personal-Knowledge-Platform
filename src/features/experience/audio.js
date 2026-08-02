// @ts-check

/** @import { AudioContextFactory, AudioContextPort, AudioCue, AudioFailure, AudioOutcome, PlayCueCommand, Result } from "./contracts.js" */

export class FeedbackAudioService {
  /** @type {AudioContextFactory | null} */
  #createContext;
  /** @type {AudioCue} */
  #cue;
  /** @type {AudioContextPort | null} */
  #context = null;

  /**
   * @param {{ readonly createContext: AudioContextFactory | null, readonly cue: AudioCue }} dependencies
   */
  constructor(dependencies) {
    if (
      typeof dependencies !== "object" ||
      dependencies === null ||
      (dependencies.createContext !== null &&
        typeof dependencies.createContext !== "function") ||
      !isValidCue(dependencies.cue)
    ) {
      throw new TypeError(
        "FeedbackAudioService requires a context factory and valid cue configuration.",
      );
    }
    this.#createContext = dependencies.createContext;
    this.#cue = Object.freeze({ ...dependencies.cue });
  }

  /**
   * @param {PlayCueCommand} command
   * @returns {Promise<Result<AudioOutcome, AudioFailure>>}
   */
  async playCue(command) {
    if (
      typeof command !== "object" ||
      command === null ||
      typeof command.enabled !== "boolean" ||
      typeof command.explicitActivation !== "boolean"
    ) {
      throw new TypeError(
        "playCue requires enabled and explicitActivation booleans.",
      );
    }
    if (!command.enabled) {
      return { ok: true, value: { kind: "SoundDisabled" } };
    }
    if (!command.explicitActivation) {
      return { ok: false, error: { kind: "AudioActivationRequired" } };
    }
    if (this.#context === null) {
      if (this.#createContext === null) {
        return { ok: false, error: { kind: "AudioUnsupported" } };
      }
      try {
        const created = this.#createContext();
        if (!isAudioContextPort(created)) {
          return { ok: false, error: { kind: "AudioUnsupported" } };
        }
        this.#context = created;
      } catch {
        return { ok: false, error: { kind: "AudioUnsupported" } };
      }
    }

    if (this.#context.state === "suspended") {
      try {
        await this.#context.resume();
      } catch {
        return { ok: false, error: { kind: "AudioResumeFailed" } };
      }
    }
    if (this.#context.state !== "running") {
      return { ok: false, error: { kind: "AudioPlaybackFailed" } };
    }

    try {
      const startedAt = this.#context.currentTime;
      const stoppedAt = startedAt + this.#cue.durationSeconds;
      const oscillator = this.#context.createOscillator();
      const gain = this.#context.createGain();
      oscillator.type = this.#cue.oscillatorType;
      oscillator.frequency.setValueAtTime(this.#cue.frequencyHz, startedAt);
      gain.gain.setValueAtTime(this.#cue.peakGain, startedAt);
      gain.gain.exponentialRampToValueAtTime(0.0001, stoppedAt);
      oscillator.connect(gain);
      gain.connect(this.#context.destination);
      oscillator.start(startedAt);
      oscillator.stop(stoppedAt);
      return { ok: true, value: { kind: "CuePlayed" } };
    } catch {
      return { ok: false, error: { kind: "AudioPlaybackFailed" } };
    }
  }
}

/**
 * @param {unknown} value
 * @returns {value is AudioCue}
 */
function isValidCue(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const cue =
    /** @type {{ frequencyHz?: unknown, durationSeconds?: unknown, peakGain?: unknown, oscillatorType?: unknown }} */ (
      value
    );
  return (
    typeof cue.frequencyHz === "number" &&
    Number.isFinite(cue.frequencyHz) &&
    cue.frequencyHz > 0 &&
    typeof cue.durationSeconds === "number" &&
    Number.isFinite(cue.durationSeconds) &&
    cue.durationSeconds > 0 &&
    typeof cue.peakGain === "number" &&
    Number.isFinite(cue.peakGain) &&
    cue.peakGain > 0 &&
    cue.peakGain <= 1 &&
    (cue.oscillatorType === "sine" ||
      cue.oscillatorType === "square" ||
      cue.oscillatorType === "sawtooth" ||
      cue.oscillatorType === "triangle")
  );
}

/**
 * @param {unknown} value
 * @returns {value is AudioContextPort}
 */
function isAudioContextPort(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const context =
    /** @type {{ state?: unknown, currentTime?: unknown, resume?: unknown, createOscillator?: unknown, createGain?: unknown }} */ (
      value
    );
  return (
    (context.state === "running" || context.state === "suspended" ||
      context.state === "closed") &&
    typeof context.currentTime === "number" &&
    Number.isFinite(context.currentTime) &&
    typeof context.resume === "function" &&
    typeof context.createOscillator === "function" &&
    typeof context.createGain === "function"
  );
}
