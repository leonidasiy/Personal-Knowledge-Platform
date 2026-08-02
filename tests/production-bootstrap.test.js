// @ts-check

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

Deno.test("production bootstrap seeds only the approved owner, Music area, and empty R2 ledger", async () => {
  const sql = await Deno.readTextFile(
    new URL("../worker/seeds/0001_personal_music.sql", import.meta.url),
  );
  for (
    const evidence of [
      "'personal-owner-v1'",
      "'music'",
      "'Music'",
      "'resonance-r2-free-v1'",
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
