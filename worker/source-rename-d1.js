// @ts-check
import { isRecord } from "../src/features/source-library/contracts.js";
import { isSourceRenameCommand } from "../src/features/source-library/rename.js";
/** @import { D1DatabasePort } from './source-library-d1.js' */
/** @import { Result } from '../src/features/source-library/contracts.js' */
/** @import { SourceRenameCommit,SourceRenameFailure,SourceRenameResult,SourceUploadContextCommand } from '../src/features/source-library/rename.js' */

export class D1SourceRenameRepository {
  /** @type {D1DatabasePort} */
  #database;
  /** @param {D1DatabasePort} database */
  constructor(database) {
    if (
      typeof database?.prepare !== "function" ||
      typeof database.batch !== "function"
    ) throw new TypeError("Source rename database is invalid.");
    this.#database = database;
  }
  /** @param {SourceUploadContextCommand} command @returns {Promise<Result<{readonly revision:number,readonly failureKind:string|null},SourceRenameFailure>>} */
  async context(command) {
    if (
      !isRecord(command) ||
      ![command.ownerId, command.sourceId, command.runId].every((value) =>
        typeof value === "string" && value.trim() !== ""
      )
    ) return { ok: false, error: { kind: "SourceRenameCommandInvalid" } };
    try {
      const row = await this.#database.prepare(
        "SELECT r.source_revision,r.failure_kind,r.state,s.revision,s.state AS source_state,r.canonical_source_identity,s.canonical_url,(SELECT latest.run_id FROM knowledge_workflow_runs latest WHERE latest.owner_id=s.owner_id AND latest.source_id=s.source_id AND latest.source_revision=s.revision ORDER BY latest.updated_at DESC,latest.run_id DESC LIMIT 1) AS latest_run_id FROM knowledge_workflow_runs r JOIN library_sources s ON s.owner_id=r.owner_id AND s.source_id=r.source_id WHERE r.owner_id=? AND r.source_id=? AND r.run_id=?",
      ).bind(command.ownerId, command.sourceId, command.runId).first();
      if (row === null) {
        return { ok: false, error: { kind: "SourceUploadContextUnavailable" } };
      }
      if (
        !isRecord(row) || typeof row.revision !== "number" ||
        (row.failure_kind !== null && typeof row.failure_kind !== "string")
      ) throw new TypeError("Stored upload context is invalid.");
      if (
        row.state !== "awaiting-upload" || row.source_state !== "active" ||
        row.source_revision !== row.revision ||
        row.latest_run_id !== command.runId ||
        row.canonical_source_identity !== row.canonical_url
      ) return { ok: false, error: { kind: "SourceRenameConflict" } };
      return {
        ok: true,
        value: { revision: row.revision, failureKind: row.failure_kind },
      };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { ok: false, error: { kind: "SourceUploadContextReadFailed" } };
    }
  }
  /** @param {SourceRenameCommit} commit @returns {Promise<Result<SourceRenameResult,SourceRenameFailure>>} */
  async rename(commit) {
    if (
      !isRecord(commit) || !isSourceRenameCommand(commit.command) ||
      typeof commit.eventId !== "string" || !commit.eventId ||
      typeof commit.fingerprint !== "string" || !commit.fingerprint ||
      !Number.isFinite(Date.parse(commit.occurredAt))
    ) return { ok: false, error: { kind: "SourceRenameCommandInvalid" } };
    const c = commit.command;
    try {
      const replay = await this.#replay(
        c.ownerId,
        c.idempotencyKey,
        commit.fingerprint,
      );
      if (replay !== null) return replay;
      const context = await this.#database.prepare(
        "SELECT r.run_id FROM library_sources s JOIN knowledge_workflow_runs r ON r.owner_id=s.owner_id AND r.source_id=s.source_id WHERE s.owner_id=? AND s.source_id=? AND r.run_id=?",
      ).bind(c.ownerId, c.sourceId, c.runId).first();
      if (context === null) {
        return { ok: false, error: { kind: "SourceUploadContextUnavailable" } };
      }
      const results = await this.#database.batch([
        this.#database.prepare(
          "INSERT INTO library_source_events (owner_id,event_id,source_id,event_kind,source_revision,idempotency_key,command_fingerprint,occurred_at,old_title,new_title,run_id) VALUES (?,?,?,'renamed',?,?,?,?,?,?,?)",
        ).bind(
          c.ownerId,
          commit.eventId,
          c.sourceId,
          c.expectedRevision,
          c.idempotencyKey,
          commit.fingerprint,
          commit.occurredAt,
          c.expectedTitle,
          c.title,
          c.runId,
        ),
      ]);
      if (
        results.length !== 1 || results[0]?.success !== true ||
        typeof results[0]?.meta?.changes !== "number" ||
        results[0].meta.changes < 1
      ) return { ok: false, error: { kind: "SourceRenamePersistenceFailed" } };
      return {
        ok: true,
        value: Object.freeze({
          sourceId: c.sourceId,
          runId: c.runId,
          title: c.title,
          revision: c.expectedRevision,
          reused: false,
        }),
      };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (
        error.message.includes("source-rename-conflict") ||
        error.message.includes("UNIQUE constraint failed")
      ) {
        try {
          const replay = await this.#replay(
            c.ownerId,
            c.idempotencyKey,
            commit.fingerprint,
          );
          if (replay !== null) return replay;
        } catch (replayError) {
          if (!(replayError instanceof Error)) throw replayError;
          return {
            ok: false,
            error: { kind: "SourceRenamePersistenceFailed" },
          };
        }
      }
      if (error.message.includes("source-rename-conflict")) {
        return { ok: false, error: { kind: "SourceRenameConflict" } };
      }
      return { ok: false, error: { kind: "SourceRenamePersistenceFailed" } };
    }
  }
  /** @param {string} ownerId @param {string} key @param {string} fingerprint @returns {Promise<Result<SourceRenameResult,SourceRenameFailure>|null>} */
  async #replay(ownerId, key, fingerprint) {
    const row = await this.#database.prepare(
      "SELECT source_id,event_kind,source_revision,command_fingerprint,new_title,run_id FROM library_source_events WHERE owner_id=? AND idempotency_key=?",
    ).bind(ownerId, key).first();
    if (row === null) return null;
    if (!isRecord(row)) {
      throw new TypeError("Stored source rename event is invalid.");
    }
    if (
      row.event_kind !== "renamed" || row.command_fingerprint !== fingerprint
    ) {
      return {
        ok: false,
        error: { kind: "SourceRenameIdempotencyConflict" },
      };
    }
    if (
      typeof row.source_id !== "string" || typeof row.run_id !== "string" ||
      typeof row.new_title !== "string" ||
      typeof row.source_revision !== "number"
    ) throw new TypeError("Stored source rename result is invalid.");
    return {
      ok: true,
      value: Object.freeze({
        sourceId: row.source_id,
        runId: row.run_id,
        title: row.new_title,
        revision: row.source_revision,
        reused: true,
      }),
    };
  }
}
