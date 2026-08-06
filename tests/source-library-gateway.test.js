// @ts-check

import { SourceLibraryGatewayClient } from "../src/features/source-library/gateway.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

const source = Object.freeze({
  id: "source-a",
  ownerId: "owner-a",
  submittedUrl: "https://publisher.example/learn",
  canonicalUrl: "https://publisher.example/learn",
  title: "Music learning source",
  description: "A source already approved for the Library.",
  adapter: Object.freeze({
    id: "adapter-a",
    version: "1",
    granularity: "root",
    capabilities: Object.freeze(["metadata"]),
  }),
  interestAreaIds: Object.freeze(["area-a"]),
  identityEvidence: Object.freeze([]),
  state: "active",
  approvedAt: "2026-07-22T08:00:00.000Z",
  updatedAt: "2026-07-22T08:00:00.000Z",
  revision: 1,
});

/** @param {(request: Request) => Promise<Response>} respond */
function gateway(respond) {
  return new SourceLibraryGatewayClient({
    fetch: (input, init) => respond(new Request(input, init)),
    baseUrl: "https://app.example/",
    timeoutMs: 100,
  });
}

Deno.test("source gateway invokes injected fetch without rebinding its receiver", async () => {
  let requests = 0;
  const receiverSensitiveFetch = /** @type {typeof fetch} */ (
    /** @this {undefined} */ function (input, init) {
      if (this !== undefined) {
        return Promise.reject(new TypeError("Fetch receiver changed."));
      }
      requests += 1;
      const request = new Request(input, init);
      if (request.method === "POST") {
        return Promise.resolve(Response.json({
          result: { source, reused: false },
        }));
      }
      return Promise.resolve(Response.json({
        result: {
          items: [],
          interestAreas: [{
            id: "area-a",
            ownerId: "owner-a",
            title: "Music",
            provenance: "configured",
          }],
          nextCursor: null,
        },
      }));
    }
  );
  const client = new SourceLibraryGatewayClient({
    fetch: receiverSensitiveFetch,
    baseUrl: "https://app.example/",
    timeoutMs: 100,
  });

  const browse = await client.browse({ limit: 20 });
  assertEquals(browse.ok, true);
  if (!browse.ok) throw new Error(browse.error.kind);
  assertEquals(browse.value.interestAreas[0].title, "Music");

  const approved = await client.approve({
    submittedUrl: source.submittedUrl,
    canonicalUrl: source.canonicalUrl,
    title: source.title,
    description: source.description,
    adapter: source.adapter,
    interestAreaIds: source.interestAreaIds,
    identityEvidence: source.identityEvidence,
    identityStatus: "resolved",
    idempotencyKey: "approve-a",
  });
  assertEquals(approved.ok, true);
  assertEquals(requests, 2);
});

Deno.test("source gateway reads a validated bounded catalog page", async () => {
  let requested = "";
  const client = gateway((request) => {
    requested = request.url;
    return Promise.resolve(Response.json({
      ownerId: "owner-a",
      result: {
        items: [source],
        interestAreas: [{
          id: "area-a",
          ownerId: "owner-a",
          title: "Music",
          provenance: "configured",
        }],
        nextCursor: "signed-cursor",
      },
    }));
  });
  const result = await client.browse({ limit: 20, cursor: "previous" });
  assertEquals(result.ok, true);
  if (!result.ok) throw new Error(result.error.kind);
  assertEquals(result.value.items[0].id, "source-a");
  assertEquals(result.value.nextCursor, "signed-cursor");
  assertEquals(new URL(requested).searchParams.get("limit"), "20");
  assertEquals(new URL(requested).searchParams.get("cursor"), "previous");
});

Deno.test("source gateway validates search results and disabled sources", async () => {
  const valid = await gateway(() =>
    Promise.resolve(Response.json({ result: [{ source, score: 0.75 }] }))
  ).search({ query: "harmony", mode: "keyword", limit: 10 });
  assertEquals(valid.ok, true);
  if (!valid.ok) throw new Error(valid.error.kind);
  assertEquals(valid.value[0].score, 0.75);

  const invalid = await gateway(() =>
    Promise.resolve(
      Response.json({
        result: [{ source: { ...source, state: "disabled" }, score: 1 }],
      }),
    )
  ).search({ query: "harmony", mode: "semantic", limit: 10 });
  assertEquals(invalid.ok, false);
  if (invalid.ok) throw new Error("Expected invalid response.");
  assertEquals(invalid.error.kind, "SourceGatewayResponseInvalid");
});

Deno.test("source gateway defaults omitted search mode to Combined", async () => {
  let requested = "";
  const result = await gateway((request) => {
    requested = request.url;
    return Promise.resolve(Response.json({ result: [{ source, score: 0.75 }] }));
  }).search({ query: "harmony", limit: 10 });
  assertEquals(result.ok, true);
  assertEquals(new URL(requested).searchParams.get("mode"), "combined");
});

Deno.test("source gateway mutations omit owner and expose server rejection", async () => {
  /** @type {unknown} */ let body = null;
  const client = gateway(async (request) => {
    body = await request.json();
    return Response.json({ error: "SourceRevisionStale" }, { status: 409 });
  });
  const result = await client.disable({
    sourceId: "source-a",
    expectedRevision: 1,
    idempotencyKey: "disable-a",
  });
  assertEquals(result.ok, false);
  if (result.ok) throw new Error("Expected rejection.");
  assertEquals(result.error.kind, "SourceGatewayRejected");
  if (result.error.kind !== "SourceGatewayRejected") {
    throw new Error("Expected server failure.");
  }
  assertEquals(result.error.failureKind, "SourceRevisionStale");
  assertEquals(
    Object.hasOwn(/** @type {Record<string, unknown>} */ (body), "ownerId"),
    false,
  );
});

Deno.test("source gateway distinguishes authentication, availability, and malformed data", async () => {
  const unauthenticated = await gateway(() =>
    Promise.resolve(new Response(null, { status: 401 }))
  ).browse({ limit: 10 });
  assertEquals(unauthenticated.ok, false);
  if (unauthenticated.ok) throw new Error("Expected authentication failure.");
  assertEquals(unauthenticated.error.kind, "SourceGatewayUnauthenticated");

  const unavailable = await gateway(() =>
    Promise.reject(new TypeError("offline"))
  ).browse({ limit: 10 });
  assertEquals(unavailable.ok, false);
  if (unavailable.ok) throw new Error("Expected unavailable failure.");
  assertEquals(unavailable.error.kind, "SourceGatewayUnavailable");

  const malformed = await gateway(() =>
    Promise.resolve(Response.json({ result: { items: "not-array" } }))
  ).browse({ limit: 10 });
  assertEquals(malformed.ok, false);
  if (malformed.ok) throw new Error("Expected response failure.");
  assertEquals(malformed.error.kind, "SourceGatewayResponseInvalid");
});

Deno.test("source gateway checks a bounded suppression projection", async () => {
  /** @type {unknown} */ let body = null;
  const client = gateway(async (request) => {
    body = await request.json();
    return Response.json({ result: ["identity-b"] });
  });
  const result = await client.suppressed(["identity-a", "identity-b"]);
  assertEquals(result.ok, true);
  if (!result.ok) throw new Error(result.error.kind);
  assertEquals(result.value.join(","), "identity-b");
  const identities = /** @type {Record<string, unknown>} */ (body)
    .canonicalIdentities;
  assertEquals(Array.isArray(identities) ? identities.length : -1, 2);
});

Deno.test("source gateway validates the active source projection", async () => {
  /** @type {unknown} */ let body = null;
  const client = gateway(async (request) => {
    body = await request.json();
    return Response.json({ result: ["source-a"] });
  });
  const result = await client.active(["source-a", "source-disabled"]);
  assertEquals(result.ok, true);
  if (!result.ok) throw new Error(result.error.kind);
  assertEquals(result.value.join(","), "source-a");
  const sourceIds = /** @type {Record<string, unknown>} */ (body).sourceIds;
  assertEquals(Array.isArray(sourceIds) ? sourceIds.length : -1, 2);

  const injected = await gateway(() =>
    Promise.resolve(Response.json({ result: ["source-not-requested"] }))
  ).active(["source-a"]);
  assertEquals(injected.ok, false);
  if (injected.ok) throw new Error("Expected invalid active projection.");
  assertEquals(injected.error.kind, "SourceGatewayResponseInvalid");
});
