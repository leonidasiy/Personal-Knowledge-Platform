// @ts-check

import { validateCandidate } from "../src/features/catalog/contracts.js";
import { catalogFixtures } from "../src/features/catalog/fixture.js";
import { CatalogRepository } from "../src/features/catalog/repository.js";

/**
 * @template T
 * @param {T} actual
 * @param {T} expected
 */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

Deno.test("catalog accepts a complete, rights-safe fixture", () => {
  const result = CatalogRepository.create(catalogFixtures);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.list().length, 5);
    assertEquals(result.value.get(catalogFixtures[0].id).ok, true);
  }
});

Deno.test("production catalog data matches the typed fixture source", async () => {
  const text = await Deno.readTextFile(
    new URL("../assets/catalog-fixtures.json", import.meta.url),
  );
  assertEquals(
    JSON.stringify(JSON.parse(text)),
    JSON.stringify(catalogFixtures),
  );
});

Deno.test("fixture inventory supports an exact default set and every approved question kind", () => {
  assertEquals(catalogFixtures.length, 5);
  const kinds = new Set(
    catalogFixtures.map((candidate) => candidate.quiz.kind),
  );
  for (
    const kind of [
      "single-choice",
      "multiple-choice",
      "fill-blank",
      "free-response",
      "case-study",
    ]
  ) {
    assertEquals(kinds.has(kind), true);
  }
});

Deno.test("catalog rejects duplicate candidate identities", () => {
  const result = CatalogRepository.create([
    catalogFixtures[0],
    catalogFixtures[0],
  ]);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.kind, "CandidateDuplicate");
  }
});

Deno.test("catalog rejects missing rights evidence", () => {
  const candidate = structuredClone(catalogFixtures[0]);
  candidate.rights.basis = "";
  const result = validateCandidate(candidate);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.kind, "RightsEvidenceMissing");
  }
});

Deno.test("catalog rejects incomplete provenance", () => {
  const candidate = structuredClone(catalogFixtures[0]);
  candidate.discovery.canonicalUrl = "not a URL";
  const result = validateCandidate(candidate);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.kind, "ProvenanceIncomplete");
  }
});

Deno.test("catalog rejects incomplete responsive artwork metadata", () => {
  const candidate = structuredClone(catalogFixtures[0]);
  candidate.artworkCompactWidth = candidate.artworkWidth;
  const result = validateCandidate(candidate);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.kind, "CandidateMalformed");
    if (result.error.kind === "CandidateMalformed") {
      assertEquals(result.error.field, "artwork");
    }
  }
});

Deno.test("catalog returns a named missing-candidate failure", () => {
  const result = CatalogRepository.create(catalogFixtures);
  assertEquals(result.ok, true);
  if (result.ok) {
    const missing = result.value.get("not-present");
    assertEquals(missing.ok, false);
    if (!missing.ok) {
      assertEquals(missing.error.kind, "CandidateMissing");
    }
  }
});
