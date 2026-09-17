// @ts-check

import { isSourceRightsProfile, validateSourceRightsProfile } from "../src/features/source-library/rights-profile.js";

const profile = Object.freeze({
  profileId: "profile-v1",
  canonicalRootUrl: "https://example.test/learn/",
  origin: "https://example.test/",
  access: "public",
  attributionText: "Example source attribution.",
  robotsUrl: "https://example.test/robots.txt",
  evidence: Object.freeze([
    "copyright", "licence", "terms", "access", "storage", "display", "transformation", "attribution", "origin",
  ].map((capability) => Object.freeze({ capability, outcome: "allowed", reference: "https://example.test/license", observedAt: "2026-08-17T00:00:00.000Z", expiresAt: null }))),
});

Deno.test("rights profile requires complete source-backed evidence before it can enter a workflow", () => {
  const valid = validateSourceRightsProfile(profile);
  if (!valid.ok) throw new Error(valid.error.field);
  if (!isSourceRightsProfile(valid.value)) throw new Error("Expected the normalized profile to remain valid.");
  const missing = validateSourceRightsProfile({ ...profile, evidence: profile.evidence.slice(0, -1) });
  if (missing.ok) throw new Error("Expected incomplete rights evidence to fail closed.");
  if (missing.error.kind !== "SourceRightsProfileInvalid") throw new Error(missing.error.kind);
});

Deno.test("rights profile rejects a client-style origin mismatch", () => {
  const result = validateSourceRightsProfile({ ...profile, origin: "https://other.example/" });
  if (result.ok) throw new Error("Expected mismatched origin to be rejected.");
  if (result.error.field !== "origin") throw new Error(result.error.field);
});
