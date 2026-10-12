import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { validateMigrationChain } from "../scripts/validate-migration-chain.mjs";

const migrationDirectory = new URL("../worker/migrations/", import.meta.url);
const execFileAsync = promisify(execFile);

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
}

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param {string} actual @param {RegExp} pattern */
function assertMatch(actual, pattern) {
  assert(pattern.test(actual), `Expected ${actual} to match ${pattern}.`);
}

/** @param {unknown} result @param {string} kind */
function assertFailure(result, kind) {
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(result.error.kind, kind);
}

test("validates the ordered migration chain and its SQLite invariants", async () => {
  const output = await execFileAsync(process.execPath, ["--permission", "--allow-fs-read=worker/migrations", "./scripts/validate-migration-chain.mjs"], { encoding: "utf8" });

  assertEquals(output.stderr, "");
  assertMatch(
    output.stdout.trim(),
    new RegExp("^Validated " + (await readdir(migrationDirectory)).filter(f=>f.endsWith(".sql")).length + " migrations and [1-9][0-9]* schema objects[.]$"),
  );
});

test("reports RuntimeUnavailable when the database runtime cannot be created", async () => {
  const result = await validateMigrationChain({
    migrationDirectory,
    createDatabase: () => null,
  });

  assertFailure(result, "RuntimeUnavailable");
});

test("reports RuntimeFeatureMissing when the injected runtime lacks SQLite features", async () => {
  const result = await validateMigrationChain({
    migrationDirectory,
    createDatabase: () => ({ exec() {} }),
  });

  assertFailure(result, "RuntimeFeatureMissing");
});

test("reports MigrationDiscoveryFailed for a non-contiguous configured directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "migration-chain-gap-"));
  await writeFile(join(directory, "0001_first.sql"), "SELECT 1;");
  await writeFile(join(directory, "0003_third.sql"), "SELECT 1;");

  const result = await validateMigrationChain({
    migrationDirectory: directory,
    createDatabase: () => null,
  });

  assertFailure(result, "MigrationDiscoveryFailed");
});

test("reports MigrationApplyFailed with the migration that failed", async () => {
  const result = await validateMigrationChain({
    migrationDirectory,
    createDatabase: () => ({
      exec() {
        throw new Error("synthetic apply failure");
      },
      prepare() {
        throw new Error("unreachable");
      },
    }),
  });

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.kind, "MigrationApplyFailed");
    const migration = result.error.migration;
    if (migration === undefined) throw new Error("Expected the failed migration.");
    assertEquals(migration.name, "0001_source_library.sql");
  }
});

test("reports MigrationInvariantFailed when SQLite metadata violates the contract", async () => {
  const result = await validateMigrationChain({
    migrationDirectory,
    createDatabase: () => ({
      exec() {},
      prepare(/** @type {string} */ query) {
        return {
          all() {
            if (query.includes("foreign_key_check")) return [{ table: "broken" }];
            if (query.includes("sqlite_schema")) return [];
            if (query.includes("foreign_keys")) return [{ foreign_keys: 0 }];
            return [{ integrity_check: "not ok" }];
          },
        };
      },
    }),
  });

  assertFailure(result, "MigrationInvariantFailed");
});
