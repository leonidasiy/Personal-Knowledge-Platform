// @ts-check

import { createRightsAssessor } from "../src/features/knowledge-workflows/rights.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

const capabilities = ["copyright", "licence", "terms", "access", "storage", "display", "transformation", "attribution", "origin"];

function command(overrides = {}) {
  return {
    ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1,
    canonicalUrl: "https://example.test/lesson", origin: "https://example.test", access: "public",
    requestedAt: "2026-08-13T00:00:00.000Z",
    evidence: capabilities.map((capability) => ({ capability, outcome: "allowed", reference: `https://example.test/evidence/${capability}`, observedAt: "2026-08-13T00:00:00.000Z", expiresAt: "2026-08-14T00:00:00.000Z" })),
    ...overrides,
  };
}

Deno.test("rights assessment succeeds before any robots or page action", () => {
  /** @type {string[]} */
  const events = [];
  const assessor = createRightsAssessor({ now: () => "2026-08-13T12:00:00.000Z", logger: (entry) => events.push(entry.event) });
  const result = assessor.assess(command());
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.status, "allowed");
  assertEquals(events.join(","), "rights-assessor-entry,rights-assessor-success");
});

Deno.test("rights assessment fails closed for restricted, unknown, conflicting, and expired evidence", () => {
  const assessor = createRightsAssessor({ now: () => "2026-08-13T12:00:00.000Z", logger: () => {} });
  const restricted = assessor.assess(command({ access: "paywalled" }));
  assertEquals(restricted.ok, true);
  if (restricted.ok) assertEquals(restricted.value.status, "denied");
  const unknown = assessor.assess(command({ evidence: command().evidence.map((entry) => entry.capability === "licence" ? { ...entry, outcome: "unknown" } : entry) }));
  assertEquals(unknown.ok, true);
  if (unknown.ok) { assertEquals(unknown.value.status, "awaiting-review"); assertEquals(unknown.value.reason, "RightsEvidenceUnknown"); }
  const conflict = assessor.assess(command({ evidence: [...command().evidence, { ...command().evidence[0], outcome: "denied" }] }));
  assertEquals(conflict.ok, true);
  if (conflict.ok) assertEquals(conflict.value.reason, "RightsEvidenceConflicting");
  const expired = assessor.assess(command({ evidence: command().evidence.map((entry) => entry.capability === "origin" ? { ...entry, expiresAt: "2026-08-13T11:59:00.000Z" } : entry) }));
  assertEquals(expired.ok, true);
  if (expired.ok) assertEquals(expired.value.reason, "RightsEvidenceExpired");
});
