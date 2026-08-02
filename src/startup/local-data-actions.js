// @ts-check

import { LOCAL_DATA_SCHEMA_VERSION } from "../persistence/contracts.js";

/** @import { ExperienceSettings } from "../features/experience/contracts.js" */
/** @import { PersistenceEnvelope, PersistenceFailure, RecordKind } from "../persistence/contracts.js" */
/** @template T @template E @typedef {{readonly ok:true,readonly value:T}|{readonly ok:false,readonly error:E}} Result */
/** @typedef {{list(ownerId:string,kind:RecordKind):Promise<Result<readonly PersistenceEnvelope[],PersistenceFailure>>,eraseOwner(ownerId:string):Promise<Result<number,PersistenceFailure>>}} LocalDataPersistence */
/** @typedef {{erase():Result<true,{readonly kind:string}>}} LocalSettingsPersistence */
/** @typedef {{readonly kind:"LocalDataExportReadFailed",readonly persistenceKind:PersistenceFailure["kind"]}|{readonly kind:"LocalDataLearningEraseFailed",readonly persistenceKind:PersistenceFailure["kind"]}|{readonly kind:"LocalDataSettingsEraseFailed",readonly settingsKind:string}} LocalDataFailure */

/**
 * @param {{
 *   readonly ownerId:string,
 *   readonly persistence:LocalDataPersistence,
 *   readonly recordKinds:readonly RecordKind[],
 *   readonly experienceSettings:ExperienceSettings,
 *   readonly now:()=>string,
 *   readonly document:Document,
 *   readonly url:Pick<typeof URL,"createObjectURL"|"revokeObjectURL">
 * }} input
 * @returns {Promise<Result<true,LocalDataFailure>>}
 */
export async function exportLocalData(input) {
  /** @type {PersistenceEnvelope[]} */
  const records = [];
  for (const kind of input.recordKinds) {
    const listed = await input.persistence.list(input.ownerId, kind);
    if (!listed.ok) {
      return {
        ok: false,
        error: {
          kind: "LocalDataExportReadFailed",
          persistenceKind: listed.error.kind,
        },
      };
    }
    records.push(...listed.value);
  }
  const blob = new Blob([
    JSON.stringify(
      {
        schemaVersion: LOCAL_DATA_SCHEMA_VERSION,
        exportedAt: input.now(),
        ownerId: input.ownerId,
        experienceSettings: input.experienceSettings,
        records,
      },
      null,
      2,
    ),
  ], { type: "application/json" });
  const objectUrl = input.url.createObjectURL(blob);
  const link = input.document.createElement("a");
  link.href = objectUrl;
  link.download = "resonance-local-export.json";
  link.click();
  input.url.revokeObjectURL(objectUrl);
  return { ok: true, value: true };
}

/**
 * @param {{readonly ownerId:string,readonly persistence:LocalDataPersistence,readonly settings:LocalSettingsPersistence}} input
 * @returns {Promise<Result<true,LocalDataFailure>>}
 */
export async function eraseLocalData(input) {
  const erased = await input.persistence.eraseOwner(input.ownerId);
  if (!erased.ok) {
    return {
      ok: false,
      error: {
        kind: "LocalDataLearningEraseFailed",
        persistenceKind: erased.error.kind,
      },
    };
  }
  const settingsErased = input.settings.erase();
  return settingsErased.ok ? { ok: true, value: true } : {
    ok: false,
    error: {
      kind: "LocalDataSettingsEraseFailed",
      settingsKind: settingsErased.error.kind,
    },
  };
}
