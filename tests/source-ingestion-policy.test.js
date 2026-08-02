// @ts-check

import { SourcePolicyEvaluator } from "../src/features/source-library/ingestion-policy.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
}

const policy = Object.freeze({
  version: "bounded-v1",
  initialDepth: 2,
  maximumDepth: 5,
  maximumPages: 100,
  maximumDecodedBytes: 25 * 1024 * 1024,
  maximumConcurrency: 2,
  maximumDurationMs: 60_000,
  maximumRedirects: 4,
  refreshIntervalMs: 7 * 24 * 60 * 60 * 1000,
});

function evaluator() {
  return new SourcePolicyEvaluator({ policy, now: () => "2026-07-22T12:00:00.000Z" });
}

function evidence(outcome = "allowed") {
  return { outcome, evidenceReference: "https://publisher.example/rights", observedAt: "2026-07-22T10:00:00.000Z", expiresAt: "2026-08-22T10:00:00.000Z" };
}

function command() {
  return {
    ownerId: "owner-a", sourceId: "source-a", sourceRevision: 1,
    rootUrl: "https://publisher.example/course/", robots: "allowed",
    robotsEvidenceReference: "https://publisher.example/robots.txt", terms: "allowed",
    termsEvidenceReference: "https://publisher.example/terms", access: "public",
    accessEvidenceReference: "https://publisher.example/course/",
    rights: { storage: evidence(), display: evidence(), transformation: evidence() },
    structuralEvidence: [],
  };
}

Deno.test("source policy starts at depth two and raises depth only from in-bound structural evidence", () => {
  const standard = evaluator().assess(command());
  assertEquals(standard.ok, true);
  if (!standard.ok) return;
  assertEquals(standard.value.selectedDepth, 2);
  assertEquals(standard.value.depthReason, "policy-default");

  const raised = evaluator().assess({ ...command(), structuralEvidence: [{ kind: "navigation", evidenceUrl: "https://publisher.example/course/map", requiredDepth: 4, observedAt: "2026-07-22T11:00:00.000Z" }] });
  assertEquals(raised.ok, true);
  if (raised.ok) {
    assertEquals(raised.value.selectedDepth, 4);
    assertEquals(raised.value.depthReason, "navigation-evidence");
  }

  const crossOrigin = evaluator().assess({ ...command(), structuralEvidence: [{ kind: "sitemap", evidenceUrl: "https://other.example/course/map", requiredDepth: 4, observedAt: "2026-07-22T11:00:00.000Z" }] });
  assertEquals(crossOrigin.ok, true);
  if (crossOrigin.ok) assertEquals(crossOrigin.value.selectedDepth, 2);
});

Deno.test("source policy rejects structural depth beyond the injected hard maximum", () => {
  const result = evaluator().assess({ ...command(), structuralEvidence: [{ kind: "sitemap", evidenceUrl: "https://publisher.example/course/sitemap.xml", requiredDepth: 6, observedAt: "2026-07-22T11:00:00.000Z" }] });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "CrawlDepthLimitExceeded");
});

Deno.test("robots, terms, access, rights, and expiry failures stay distinct", () => {
  const cases = [
    [{ ...command(), robots: "unavailable" }, "RobotsFetchUnavailable"],
    [{ ...command(), robots: "malformed" }, "RobotsMalformed"],
    [{ ...command(), robots: "denied" }, "RobotsDenied"],
    [{ ...command(), terms: "unknown" }, "TermsUnknown"],
    [{ ...command(), terms: "denied" }, "TermsDenied"],
    [{ ...command(), access: "denied" }, "PublicAccessDenied"],
    [{ ...command(), access: "authentication-required" }, "AuthenticationRequired"],
    [{ ...command(), access: "paywall" }, "PaywallDetected"],
    [{ ...command(), rights: { ...command().rights, storage: evidence("unknown") } }, "ContentRightsUnknown"],
    [{ ...command(), rights: { ...command().rights, display: evidence("denied") } }, "ContentDisplayDenied"],
    [{ ...command(), rights: { ...command().rights, transformation: { ...evidence(), expiresAt: "2026-07-22T12:00:00.000Z" } } }, "RightsEvidenceExpired"],
  ];
  for (const [input, kind] of cases) {
    const result = evaluator().assess(input);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, kind);
  }
});

Deno.test("every exact runner boundary passes and every one-over boundary is named", () => {
  const exact = { pages: 100, depth: 5, decodedBytes: 25 * 1024 * 1024, concurrency: 2, durationMs: 60_000, redirects: 4 };
  assertEquals(evaluator().checkBoundary(exact).ok, true);
  const cases = [
    [{ ...exact, pages: 101 }, "CrawlPageLimitExceeded"],
    [{ ...exact, depth: 6 }, "CrawlDepthLimitExceeded"],
    [{ ...exact, decodedBytes: exact.decodedBytes + 1 }, "CrawlByteLimitExceeded"],
    [{ ...exact, concurrency: 3 }, "CrawlConcurrencyLimitExceeded"],
    [{ ...exact, durationMs: 60_001 }, "CrawlDurationLimitExceeded"],
    [{ ...exact, redirects: 5 }, "CrawlRedirectLimitExceeded"],
  ];
  for (const [input, kind] of cases) {
    const result = evaluator().checkBoundary(input);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, kind);
  }
});

Deno.test("source policy validates all public inputs and injected dependencies", () => {
  let threw = false;
  try {
    new SourcePolicyEvaluator({ policy: { ...policy, maximumConcurrency: 0 }, now: () => "2026-07-22T12:00:00.000Z" });
  } catch (error) {
    threw = error instanceof TypeError;
  }
  assertEquals(threw, true);
  const result = evaluator().assess({ ...command(), rootUrl: "http://publisher.example/course/" });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.kind, "SourceIngestionCommandInvalid");
});
