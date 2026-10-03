// @ts-check
import { isRecord } from "./contracts.js";
/** @import { Result, LibrarySource, SourceLibraryFailure } from './contracts.js' */
/** @typedef {{readonly kind: 'SourceRenameCommandInvalid' | 'SourceUploadContextUnavailable' | 'SourceRenameConflict' | 'SourceRenameIdempotencyConflict' | 'SourceRenamePersistenceFailed' | 'SourceUploadContextReadFailed'}} SourceRenameFailure */
/** @typedef {{readonly ownerId:string, readonly sourceId:string, readonly runId:string, readonly expectedRevision:number, readonly expectedTitle:string, readonly title:string, readonly idempotencyKey:string}} SourceRenameCommand */
/** @typedef {{readonly sourceId:string, readonly runId:string, readonly title:string, readonly revision:number, readonly reused:boolean}} SourceRenameResult */
/** @typedef {{readonly command:SourceRenameCommand, readonly eventId:string, readonly occurredAt:string, readonly fingerprint:string}} SourceRenameCommit */
/** @typedef {{readonly ownerId:string,readonly sourceId:string,readonly runId:string}} SourceUploadContextCommand */
/** @typedef {{readonly source:LibrarySource,readonly runId:string,readonly failureKind:string|null}} SourceUploadContext */
/** @typedef {{readonly context:(command:SourceUploadContextCommand)=>Promise<Result<{readonly revision:number,readonly failureKind:string|null},SourceRenameFailure>>, readonly rename:(commit:SourceRenameCommit)=>Promise<Result<SourceRenameResult,SourceRenameFailure>>}} SourceRenameRepository */

/** @param {unknown} value @returns {value is SourceRenameCommand} */
export function isSourceRenameCommand(value) {
  return isRecord(value) && text(value.ownerId) && text(value.sourceId) &&
    text(value.runId) && typeof value.expectedRevision === "number" &&
    Number.isSafeInteger(value.expectedRevision) &&
    value.expectedRevision > 0 && typeof value.expectedTitle === "string" &&
    text(value.title) && value.title.trim().length <= 300 &&
    text(value.idempotencyKey);
}
/** @param {unknown} value @returns {value is string} */
function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** @param {SourceRenameRepository} repository @param {{read:(ownerId:string,sourceId:string)=>Promise<Result<LibrarySource|null,SourceLibraryFailure>>}} sources @param {{now:()=>string,createId:()=>string,logger:(entry:{event:string,failureKind?:string})=>void}} dependencies */
export function createSourceRenameService(repository, sources, dependencies) {
  if (
    typeof repository?.rename !== "function" ||
    typeof sources?.read !== "function" ||
    typeof dependencies?.now !== "function" ||
    typeof dependencies.createId !== "function" ||
    typeof dependencies.logger !== "function"
  ) throw new TypeError("Source rename dependencies are invalid.");
  return Object.freeze({
    /** @param {unknown} input @returns {Promise<Result<SourceUploadContext,SourceRenameFailure>>} */
    async uploadContext(input) {
      dependencies.logger({ event: "source-upload-context-entry" });
      /** @type {Result<SourceUploadContext,SourceRenameFailure>} */
      let result;
      if (
        !isRecord(input) || !text(input.ownerId) || !text(input.sourceId) ||
        !text(input.runId)
      ) result = { ok: false, error: { kind: "SourceRenameCommandInvalid" } };
      else {
        const command = {
          ownerId: input.ownerId,
          sourceId: input.sourceId,
          runId: input.runId,
        };
        const source = await sources.read(command.ownerId, command.sourceId);
        if (!source.ok) {
          result = {
            ok: false,
            error: { kind: "SourceUploadContextReadFailed" },
          };
        } else if (source.value === null) {
          result = {
            ok: false,
            error: { kind: "SourceUploadContextUnavailable" },
          };
        } else {
          const context = await repository.context(command);
          if (!context.ok) result = context;
          else if (
            source.value.revision !== context.value.revision ||
            source.value.state !== "active"
          ) result = { ok: false, error: { kind: "SourceRenameConflict" } };
          else {result = {
              ok: true,
              value: Object.freeze({
                source: source.value,
                runId: command.runId,
                failureKind: context.value.failureKind,
              }),
            };}
        }
      }
      dependencies.logger(
        result.ok ? { event: "source-upload-context-success" } : {
          event: "source-upload-context-failure",
          failureKind: result.error.kind,
        },
      );
      return result;
    },
    /** @param {unknown} input @returns {Promise<Result<SourceRenameResult,SourceRenameFailure>>} */
    async rename(input) {
      dependencies.logger({ event: "source-rename-entry" });
      if (!isSourceRenameCommand(input)) {
        dependencies.logger({
          event: "source-rename-failure",
          failureKind: "SourceRenameCommandInvalid",
        });
        return { ok: false, error: { kind: "SourceRenameCommandInvalid" } };
      }
      const command = Object.freeze({ ...input, title: input.title.trim() });
      const fingerprint = JSON.stringify([
        command.sourceId,
        command.runId,
        command.expectedRevision,
        command.expectedTitle,
        command.title,
      ]);
      const result = await repository.rename({
        command,
        fingerprint,
        eventId: dependencies.createId(),
        occurredAt: dependencies.now(),
      });
      dependencies.logger(
        result.ok
          ? { event: "source-rename-success" }
          : { event: "source-rename-failure", failureKind: result.error.kind },
      );
      return result;
    },
  });
}
