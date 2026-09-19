// @ts-check

const freeze = Object.freeze;

/** @import { ExperienceSettings, LayoutMode, Result, SettingsFailure, SettingsRepositoryDependencies, VisualTheme } from "./contracts.js" */

const SETTINGS_SCHEMA_VERSION = 2;
const LEGACY_SETTINGS_SCHEMA_VERSION = 1;

export class SettingsRepository {
  /** @type {SettingsRepositoryDependencies["storage"]} */
  #storage;
  /** @type {string} */
  #storageKey;
  /** @type {string} */
  #ownerId;
  /** @type {ReadonlySet<string>} */
  #themeIds;
  /** @type {ReadonlySet<string>} */
  #layoutIds;
  /** @type {VisualTheme} */
  #defaultVisualTheme;
  /** @type {LayoutMode} */
  #defaultLayoutMode;

  /** @param {SettingsRepositoryDependencies} dependencies */
  constructor(dependencies) {
    if (
      typeof dependencies !== "object" ||
      dependencies === null ||
      typeof dependencies.storage?.getItem !== "function" ||
      typeof dependencies.storage?.setItem !== "function" ||
      typeof dependencies.storage?.removeItem !== "function" ||
      typeof dependencies.key !== "string" ||
      dependencies.key.length === 0 ||
      typeof dependencies.ownerId !== "string" ||
      dependencies.ownerId.length === 0
    ) {
      throw new TypeError(
        "SettingsRepository requires storage, key, owner, and preset dependencies.",
      );
    }
    this.#themeIds = validatePresetRegistry(
      dependencies.visualThemes,
      dependencies.defaultVisualTheme,
      "visualThemes",
    );
    this.#layoutIds = validatePresetRegistry(
      dependencies.layouts,
      dependencies.defaultLayoutMode,
      "layouts",
    );
    this.#storage = dependencies.storage;
    this.#ownerId = dependencies.ownerId;
    this.#defaultVisualTheme = dependencies.defaultVisualTheme;
    this.#defaultLayoutMode = dependencies.defaultLayoutMode;
    this.#storageKey = `${dependencies.key}:${
      encodeURIComponent(dependencies.ownerId)
    }`;
  }

  /** @returns {Result<ExperienceSettings, SettingsFailure>} */
  load() {
    /** @type {string | null} */
    let raw;
    try {
      raw = this.#storage.getItem(this.#storageKey);
    } catch {
      return { ok: false, error: { kind: "SettingsReadUnavailable" } };
    }
    if (raw === null) {
      return { ok: false, error: { kind: "SettingsMissing" } };
    }

    /** @type {unknown} */
    let parsed;
    try {
      parsed = /** @type {unknown} */ (JSON.parse(raw));
    } catch {
      return malformed("document");
    }
    const validated = parseSettingsRecord(
      parsed,
      this.#ownerId,
      this.#themeIds,
      this.#layoutIds,
      this.#defaultVisualTheme,
      this.#defaultLayoutMode,
    );
    if (!validated.ok) return validated;
    if (validated.value.migratedFrom === LEGACY_SETTINGS_SCHEMA_VERSION) {
      try {
        this.#storage.setItem(
          this.#storageKey,
          JSON.stringify({
            ownerId: this.#ownerId,
            ...validated.value.settings,
          }),
        );
      } catch {
        return {
          ok: false,
          error: {
            kind: "SettingsMigrationFailed",
            fromVersion: 1,
            toVersion: 2,
          },
        };
      }
    }
    return { ok: true, value: validated.value.settings };
  }

  /**
   * @param {ExperienceSettings} settings
   * @returns {Result<ExperienceSettings, SettingsFailure>}
   */
  save(settings) {
    const validated = validateSettings(
      settings,
      this.#themeIds,
      this.#layoutIds,
    );
    if (!validated.ok) return validated;
    try {
      this.#storage.setItem(
        this.#storageKey,
        JSON.stringify({ ownerId: this.#ownerId, ...validated.value }),
      );
    } catch {
      return { ok: false, error: { kind: "SettingsWriteUnavailable" } };
    }
    return validated;
  }

  /** @returns {Result<true, SettingsFailure>} */
  erase() {
    try {
      this.#storage.removeItem(this.#storageKey);
    } catch {
      return { ok: false, error: { kind: "SettingsEraseUnavailable" } };
    }
    return { ok: true, value: true };
  }
}

/**
 * @template {string} T
 * @param {readonly import("./contracts.js").ExperiencePreset<T>[]} presets
 * @param {T} defaultId
 * @param {string} field
 * @returns {ReadonlySet<string>}
 */
function validatePresetRegistry(presets, defaultId, field) {
  if (!Array.isArray(presets) || presets.length === 0) {
    throw new TypeError(`${field} must contain at least one preset.`);
  }
  const ids = new Set();
  for (const preset of presets) {
    if (
      typeof preset !== "object" ||
      preset === null ||
      typeof preset.id !== "string" ||
      preset.id.length === 0 ||
      typeof preset.label !== "string" ||
      preset.label.length === 0 ||
      typeof preset.source !== "string" ||
      preset.source.length === 0 ||
      ids.has(preset.id)
    ) {
      throw new TypeError(`${field} contains an invalid preset contract.`);
    }
    ids.add(preset.id);
  }
  if (!ids.has(defaultId)) {
    throw new TypeError(`${field} does not contain its configured default.`);
  }
  return ids;
}

/**
 * @param {unknown} value
 * @param {string} expectedOwnerId
 * @param {ReadonlySet<string>} themeIds
 * @param {ReadonlySet<string>} layoutIds
 * @param {VisualTheme} defaultVisualTheme
 * @param {LayoutMode} defaultLayoutMode
 * @returns {Result<{ readonly settings: ExperienceSettings, readonly migratedFrom: 1 | null }, SettingsFailure>}
 */
function parseSettingsRecord(
  value,
  expectedOwnerId,
  themeIds,
  layoutIds,
  defaultVisualTheme,
  defaultLayoutMode,
) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return malformed("document");
  }
  const record =
    /** @type {{ ownerId?: unknown, schemaVersion?: unknown, themeMode?: unknown, visualTheme?: unknown, layoutMode?: unknown, soundEnabled?: unknown }} */ (
      value
    );
  if (
    typeof record.schemaVersion !== "number" ||
    !Number.isInteger(record.schemaVersion)
  ) {
    return malformed("schemaVersion");
  }
  if (record.ownerId !== expectedOwnerId) {
    return malformed("ownerId");
  }
  if (record.schemaVersion === LEGACY_SETTINGS_SCHEMA_VERSION) {
    const legacy = validateLegacySettings(record);
    if (!legacy.ok) return legacy;
    return {
      ok: true,
      value: freeze({
        settings: freeze({
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          themeMode: legacy.value.themeMode,
          visualTheme: defaultVisualTheme,
          layoutMode: defaultLayoutMode,
          soundEnabled: legacy.value.soundEnabled,
        }),
        migratedFrom: 1,
      }),
    };
  }
  if (record.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    return unsupported(record.schemaVersion);
  }
  const settings = validateSettings(record, themeIds, layoutIds);
  return settings.ok
    ? {
      ok: true,
      value: freeze({ settings: settings.value, migratedFrom: null }),
    }
    : settings;
}

/**
 * @param {unknown} value
 * @returns {Result<Pick<ExperienceSettings, "themeMode" | "soundEnabled">, SettingsFailure>}
 */
function validateLegacySettings(value) {
  const legacy =
    /** @type {{ themeMode?: unknown, soundEnabled?: unknown }} */ (value);
  const mode = validateThemeMode(legacy.themeMode);
  if (!mode.ok) return mode;
  if (typeof legacy.soundEnabled !== "boolean") {
    return malformed("soundEnabled");
  }
  return {
    ok: true,
    value: freeze({
      themeMode: mode.value,
      soundEnabled: legacy.soundEnabled,
    }),
  };
}

/**
 * @param {unknown} value
 * @param {ReadonlySet<string>} themeIds
 * @param {ReadonlySet<string>} layoutIds
 * @returns {Result<ExperienceSettings, SettingsFailure>}
 */
function validateSettings(value, themeIds, layoutIds) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return malformed("document");
  }
  const settings =
    /** @type {{ schemaVersion?: unknown, themeMode?: unknown, visualTheme?: unknown, layoutMode?: unknown, soundEnabled?: unknown, motionEnabled?: unknown }} */ (
      value
    );
  if (settings.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    if (
      typeof settings.schemaVersion === "number" &&
      Number.isInteger(settings.schemaVersion)
    ) {
      return unsupported(settings.schemaVersion);
    }
    return malformed("schemaVersion");
  }
  const mode = validateThemeMode(settings.themeMode);
  if (!mode.ok) return mode;
  if (typeof settings.visualTheme !== "string") {
    return malformed("visualTheme");
  }
  if (!themeIds.has(settings.visualTheme)) {
    return {
      ok: false,
      error: {
        kind: "SettingsThemeUnknown",
        themeId: settings.visualTheme,
      },
    };
  }
  if (typeof settings.layoutMode !== "string") {
    return malformed("layoutMode");
  }
  if (!layoutIds.has(settings.layoutMode)) {
    return {
      ok: false,
      error: {
        kind: "SettingsLayoutUnknown",
        layoutId: settings.layoutMode,
      },
    };
  }
  if (typeof settings.soundEnabled !== "boolean") {
    return malformed("soundEnabled");
  }
  if (settings.motionEnabled !== undefined && typeof settings.motionEnabled !== "boolean") return malformed("motionEnabled");
  return {
    ok: true,
    value: freeze({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      themeMode: mode.value,
      visualTheme: /** @type {VisualTheme} */ (settings.visualTheme),
      layoutMode: /** @type {LayoutMode} */ (settings.layoutMode),
      soundEnabled: settings.soundEnabled,
      ...(settings.motionEnabled === undefined ? {} : { motionEnabled: settings.motionEnabled }),
    }),
  };
}

/**
 * @param {unknown} value
 * @returns {Result<import("./contracts.js").ThemeMode, SettingsFailure>}
 */
function validateThemeMode(value) {
  if (value !== "system" && value !== "light" && value !== "dark") {
    return malformed("themeMode");
  }
  return { ok: true, value };
}

/**
 * @param {string} field
 * @returns {Result<never, Extract<SettingsFailure, { kind: "SettingsMalformed" }>>}
 */
function malformed(field) {
  return { ok: false, error: { kind: "SettingsMalformed", field } };
}

/**
 * @param {number} version
 * @returns {Result<never, Extract<SettingsFailure, { kind: "SettingsVersionUnsupported" }>>}
 */
function unsupported(version) {
  return {
    ok: false,
    error: { kind: "SettingsVersionUnsupported", version },
  };
}
