// @ts-check

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

Deno.test("self-host bootstrap seeds only the configured owner, Music area, and empty R2 ledger", async () => {
  const sql = await Deno.readTextFile(
    new URL("../worker/seeds/self-host.sql", import.meta.url),
  );
  for (
    const evidence of [
      "'self-host-owner-v1'",
      "'music'",
      "'Music'",
      "'self-host-r2-v1'",
      "stored_bytes",
      "strftime('%Y-%m', 'now')",
    ]
  ) {
    assert(sql.includes(evidence), `Bootstrap is missing ${evidence}.`);
  }
  assert(
    sql.match(/ON CONFLICT[^;]+DO NOTHING/g)?.length === 3,
    "Bootstrap must be idempotent without overwriting later source or capacity state.",
  );
  assert(
    !sql.includes("DO UPDATE"),
    "Bootstrap must not overwrite a measured R2 capacity observation.",
  );
});
