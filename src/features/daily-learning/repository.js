// @ts-check

const freeze = Object.freeze;

/** @import { DailyLearningFailure, DailyLearningSettings, DailyRecallCohort, DailyStudySet, Result } from "./contracts.js" */

export class DailyLearningRepository {
  /** @type {DailyLearningSettings[]} */
  #settings = [];
  /** @type {DailyStudySet[]} */
  #studySets = [];
  /** @type {DailyRecallCohort[]} */
  #cohorts = [];

  /** @param {string} ownerId @returns {DailyLearningSettings | null} */
  getSettings(ownerId) {
    return this.#settings.findLast((settings) =>
      settings.ownerId === ownerId
    ) ?? null;
  }

  /**
   * @param {DailyLearningSettings} settings
   * @returns {Result<DailyLearningSettings, DailyLearningFailure>}
   */
  recordSettings(settings) {
    if (
      this.#settings.some((event) =>
        event.ownerId === settings.ownerId &&
        event.revision === settings.revision
      )
    ) {
      return {
        ok: false,
        error: {
          kind: "DailySettingsAlreadyRecorded",
          revision: settings.revision,
        },
      };
    }
    const frozen = freeze(settings);
    this.#settings.push(frozen);
    return { ok: true, value: frozen };
  }

  /** @param {string} ownerId @param {number} revision */
  rollbackSettings(ownerId, revision) {
    const index = this.#settings.findIndex((settings) =>
      settings.ownerId === ownerId && settings.revision === revision
    );
    if (index < 0) return false;
    this.#settings.splice(index, 1);
    return true;
  }

  /**
   * @param {DailyStudySet} studySet
   * @returns {Result<DailyStudySet, DailyLearningFailure>}
   */
  recordStudySet(studySet) {
    if (
      this.#studySets.some((event) =>
        event.ownerId === studySet.ownerId &&
        event.idempotencyKey === studySet.idempotencyKey
      )
    ) {
      return {
        ok: false,
        error: {
          kind: "DailyAssignmentAlreadyRecorded",
          idempotencyKey: studySet.idempotencyKey,
        },
      };
    }
    const frozen = freeze({
      ...studySet,
      items: freeze([...studySet.items]),
    });
    this.#studySets.push(frozen);
    return { ok: true, value: frozen };
  }

  /** @param {string} ownerId @param {string} idempotencyKey */
  rollbackStudySet(ownerId, idempotencyKey) {
    const index = this.#studySets.findIndex((set) =>
      set.ownerId === ownerId && set.idempotencyKey === idempotencyKey
    );
    if (index < 0) return false;
    this.#studySets.splice(index, 1);
    return true;
  }

  /**
   * @param {string} ownerId
   * @param {string} learningDay
   * @returns {readonly DailyStudySet[]}
   */
  listStudySets(ownerId, learningDay) {
    return freeze(
      this.#studySets
        .filter((set) =>
          set.ownerId === ownerId && set.learningDay === learningDay
        )
        .sort((left, right) => left.ordinal - right.ordinal),
    );
  }

  /** @param {string} ownerId @param {string} id @returns {DailyStudySet | null} */
  getStudySet(ownerId, id) {
    return this.#studySets.find((set) =>
      set.ownerId === ownerId && set.id === id
    ) ?? null;
  }

  /**
   * @param {DailyRecallCohort} cohort
   * @returns {Result<DailyRecallCohort, DailyLearningFailure>}
   */
  recordCohort(cohort) {
    if (
      this.#cohorts.some((event) =>
        event.ownerId === cohort.ownerId &&
        event.idempotencyKey === cohort.idempotencyKey
      )
    ) {
      return {
        ok: false,
        error: {
          kind: "RecallAssignmentAlreadyRecorded",
          idempotencyKey: cohort.idempotencyKey,
        },
      };
    }
    const frozen = freeze({
      ...cohort,
      prompts: freeze([...cohort.prompts]),
    });
    this.#cohorts.push(frozen);
    return { ok: true, value: frozen };
  }

  /** @param {string} ownerId @param {string} idempotencyKey */
  rollbackCohort(ownerId, idempotencyKey) {
    const index = this.#cohorts.findIndex((cohort) =>
      cohort.ownerId === ownerId && cohort.idempotencyKey === idempotencyKey
    );
    if (index < 0) return false;
    this.#cohorts.splice(index, 1);
    return true;
  }

  /** @param {string} ownerId @param {string} studySetId @returns {DailyRecallCohort | null} */
  getCohort(ownerId, studySetId) {
    return this.#cohorts.findLast((cohort) =>
      cohort.ownerId === ownerId && cohort.studySetId === studySetId
    ) ?? null;
  }
}
