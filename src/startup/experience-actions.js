// @ts-check

const freeze = Object.freeze;

import { applyPresentationUpdate } from "../features/experience/presentation.js";

/** @import { ExperiencePreset, ExperienceSettings, LayoutMode, SettingsFailure, ViewTransitionCapability, VisualTheme } from "../features/experience/contracts.js" */
/** @template T @template E @typedef {{readonly ok:true,readonly value:T}|{readonly ok:false,readonly error:E}} Result */
/** @typedef {{save(settings:ExperienceSettings):Result<ExperienceSettings,SettingsFailure>,erase():Result<true,SettingsFailure>}} ExperienceSettingsStore */

/**
 * @param {{
 *   readonly store:ExperienceSettingsStore,
 *   readonly getSettings:()=>ExperienceSettings,
 *   readonly setSettings:(settings:ExperienceSettings,issue:SettingsFailure|null)=>void,
 *   readonly defaultSettings:ExperienceSettings,
 *   readonly visualThemes:readonly ExperiencePreset<VisualTheme>[],
 *   readonly layouts:readonly ExperiencePreset<LayoutMode>[],
 *   readonly applyPresentation:()=>void,
 *   readonly transitions:ViewTransitionCapability,
 *   readonly reducedMotion:()=>boolean,
 *   readonly render:(focusKey:string|null,headingId:string|null)=>void,
 *   readonly playInteractionCue:()=>void
 * }} dependencies
 */
export function createExperienceActions(dependencies) {
  return freeze({
    /** @param {Element} element */
    async updateTheme(element) {
      if (!(element instanceof HTMLInputElement) || !element.checked) return;
      const mode = element.value;
      if (mode !== "system" && mode !== "light" && mode !== "dark") return;
      const current = dependencies.getSettings();
      const saved = dependencies.store.save(
        freeze({ ...current, themeMode: mode }),
      );
      if (!saved.ok) {
        dependencies.setSettings(current, saved.error);
        dependencies.render(`theme-${current.themeMode}`, null);
        return;
      }
      dependencies.setSettings(saved.value, null);
      await applyPresentationUpdate({
        update: () => {
          dependencies.applyPresentation();
          dependencies.render(`theme-${mode}`, null);
        },
        transitions: dependencies.transitions,
        reducedMotion: dependencies.reducedMotion(),
      });
      dependencies.playInteractionCue();
    },

    /** @param {Element} element @param {"visualTheme"|"layoutMode"} field */
    async updatePreset(element, field) {
      if (!(element instanceof HTMLInputElement) || !element.checked) return;
      const value = element.value;
      const allowed = field === "visualTheme"
        ? dependencies.visualThemes.some((preset) => preset.id === value)
        : dependencies.layouts.some((preset) => preset.id === value);
      if (!allowed) return;
      const current = dependencies.getSettings();
      const next = field === "visualTheme"
        ? freeze({
          ...current,
          visualTheme: /** @type {VisualTheme} */ (value),
        })
        : freeze({
          ...current,
          layoutMode: /** @type {LayoutMode} */ (value),
        });
      const saved = dependencies.store.save(next);
      if (!saved.ok) {
        dependencies.setSettings(current, saved.error);
        dependencies.render(
          `${field === "visualTheme" ? "visual-theme" : "layout"}-${
            current[field]
          }`,
          null,
        );
        return;
      }
      dependencies.setSettings(saved.value, null);
      await applyPresentationUpdate({
        update: () => {
          dependencies.applyPresentation();
          dependencies.render(
            `${field === "visualTheme" ? "visual-theme" : "layout"}-${value}`,
            null,
          );
        },
        transitions: dependencies.transitions,
        reducedMotion: dependencies.reducedMotion(),
      });
      dependencies.playInteractionCue();
    },

    /** @param {Event} event */
    updateSound(event) {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      const current = dependencies.getSettings();
      const saved = dependencies.store.save(freeze({
        ...current,
        soundEnabled: target.checked,
      }));
      if (!saved.ok) {
        dependencies.setSettings(current, saved.error);
        dependencies.render("setting-sound", null);
        return;
      }
      dependencies.setSettings(saved.value, null);
      dependencies.render("settings-summary", null);
      if (saved.value.soundEnabled) dependencies.playInteractionCue();
    },

    /** @param {Event} event */
    updateMotion(event) {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      const current = dependencies.getSettings();
      const saved = dependencies.store.save(freeze({ ...current, motionEnabled: target.checked }));
      dependencies.setSettings(saved.ok ? saved.value : current, saved.ok ? null : saved.error);
      dependencies.applyPresentation();
      dependencies.render("setting-motion", null);
    },

    reset() {
      const erased = dependencies.store.erase();
      if (!erased.ok) {
        dependencies.setSettings(dependencies.getSettings(), erased.error);
        dependencies.render("reset-settings", null);
        return;
      }
      dependencies.setSettings(dependencies.defaultSettings, null);
      dependencies.applyPresentation();
      dependencies.render("settings-summary", null);
    },
  });
}
