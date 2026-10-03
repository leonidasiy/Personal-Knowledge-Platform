import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {"RuntimeUnavailable" | "RuntimeFeatureMissing" | "MigrationDiscoveryFailed" | "MigrationApplyFailed" | "MigrationInvariantFailed"} FailureKind */

/** @typedef {{ readonly number: number, readonly name: string, readonly path: string }} Migration */

/** @typedef {{ readonly exec: (sql: string) => void, readonly prepare: (sql: string) => { readonly all: () => readonly Record<string, unknown>[] }, readonly close?: () => void }} Database */

/** @typedef {{ readonly ok: true, readonly value: { readonly migrations: readonly Migration[], readonly schemaObjects: readonly Record<string, unknown>[], readonly ftsTables: readonly string[], readonly invariants: { readonly foreignKeys: number, readonly integrityCheck: string, readonly foreignKeyViolations: readonly Record<string, unknown>[] } } } | { readonly ok: false, readonly error: { readonly kind: FailureKind, readonly message: string, readonly migration?: Migration } }} Result */

/** @param {FailureKind} kind @param {string} message @param {Migration} [migration] @returns {Result} */
function failure(kind, message, migration) {
  return migration ? { ok: false, error: { kind, message, migration } } : { ok: false, error: { kind, message } };
}

/** @param {string | URL} directory @param {string} name */
function migrationPath(directory, name) {
  return directory instanceof URL ? fileURLToPath(new URL(name, directory)) : resolve(directory, name);
}

/** @param {string | URL} directory @returns {Promise<readonly Migration[] | Result>} */
async function discoverMigrations(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const migrations = entries.flatMap((entry) => {
      if (!entry.isFile()) return [];
      const match = /^(\d{4})_.+\.sql$/.exec(entry.name);
      return match ? [{ number: Number(match[1]), name: entry.name, path: migrationPath(directory, entry.name) }] : [];
    }).sort((left, right) => left.number - right.number);

    if (migrations.length === 0 || migrations.some((migration, index) => migration.number !== index + 1)) {
      return failure("MigrationDiscoveryFailed", "Migration files must be contiguous from 0001 through the last discovered migration.");
    }
    return migrations;
  } catch (error) {
    return failure("MigrationDiscoveryFailed", `Unable to discover migrations: ${String(error)}`);
  }
}

/** @param {unknown} value @returns {value is Database} */
function isDatabase(value) {
  if (typeof value !== "object" || value === null) return false;
  const candidate = /** @type {{ readonly exec?: unknown, readonly prepare?: unknown }} */ (value);
  return typeof candidate.exec === "function" && typeof candidate.prepare === "function";
}

/** @param {Database} database @param {string} query */
function rows(database, query) {
  const statement = database.prepare(query);
  if (!statement || typeof statement.all !== "function") throw new Error("SQLite statement all() feature is unavailable.");
  return statement.all();
}

/**
 * @param {{ readonly migrationDirectory: string | URL, readonly createDatabase: () => unknown }} dependencies
 * @returns {Promise<Result>}
 */
export async function validateMigrationChain({ migrationDirectory, createDatabase }) {
  const discovered = await discoverMigrations(migrationDirectory);
  if ("ok" in discovered) return discovered;

  let database;
  try {
    database = createDatabase();
  } catch (error) {
    return failure("RuntimeUnavailable", `Unable to create SQLite runtime: ${String(error)}`);
  }
  if (!database) return failure("RuntimeUnavailable", "SQLite runtime was unavailable.");
  if (!isDatabase(database)) return failure("RuntimeFeatureMissing", "SQLite runtime must provide exec() and prepare().");

  try {
    for (const migration of discovered) {
      try {
        database.exec(await readFile(migration.path, "utf8"));
      } catch (error) {
        return failure("MigrationApplyFailed", `Unable to apply ${migration.name}: ${String(error)}`, migration);
      }
    }
  } catch (error) {
    return failure("MigrationApplyFailed", `Unable to apply migration chain: ${String(error)}`, discovered[0]);
  }

  try {
    const foreignKeys = rows(database, "PRAGMA foreign_keys")[0]?.foreign_keys;
    const integrityCheck = rows(database, "PRAGMA integrity_check")[0]?.integrity_check;
    const foreignKeyViolations = rows(database, "PRAGMA foreign_key_check");
    const schemaObjects = rows(database, "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name");
    const ftsTables = schemaObjects.flatMap((object) => typeof object.name === "string" && typeof object.sql === "string" && /\busing\s+fts\d*\b/i.test(object.sql) ? [object.name] : []);

    if (foreignKeys !== 1 || integrityCheck !== "ok" || foreignKeyViolations.length !== 0 || schemaObjects.length === 0 || ftsTables.length === 0) {
      return failure("MigrationInvariantFailed", `Migration invariants failed: foreign_keys=${String(foreignKeys)}, integrity_check=${String(integrityCheck)}, foreign_key_violations=${foreignKeyViolations.length}, schema_objects=${schemaObjects.length}, fts_tables=${ftsTables.length}.`);
    }

    return { ok: true, value: { migrations: discovered, schemaObjects, ftsTables, invariants: { foreignKeys: Number(foreignKeys), integrityCheck: String(integrityCheck), foreignKeyViolations } } };
  } catch (error) {
    return failure("MigrationInvariantFailed", `Unable to verify migration invariants: ${String(error)}`);
  } finally {
    database.close?.();
  }
}

async function runCli() {
  let DatabaseSync;
  try {
    // @ts-ignore Deno's type checker does not expose Node 22's sqlite module.
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (error) {
    console.error(`[RuntimeUnavailable] Unable to load node:sqlite: ${String(error)}`);
    return 1;
  }

  const result = await validateMigrationChain({
    migrationDirectory: new URL("../worker/migrations/", import.meta.url),
    createDatabase: () => new DatabaseSync(":memory:"),
  });
  if (!result.ok) {
    console.error(`[${result.error.kind}] ${result.error.message}`);
    return 1;
  }
  console.log(`Validated ${result.value.migrations.length} migrations and ${result.value.schemaObjects.length} schema objects.`);
  return 0;
}

// @ts-ignore Node provides process for this composition-only entry point.
if (import.meta.main) process.exitCode = await runCli();
