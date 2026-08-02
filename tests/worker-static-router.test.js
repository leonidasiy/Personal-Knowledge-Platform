// @ts-check

import { createUnifiedWorkerRouter } from "../worker/static-router.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

Deno.test("unified router serves static requests without composing the API", async () => {
  let assetCalls = 0;
  let apiCompositions = 0;
  const result = createUnifiedWorkerRouter({
    assets: {
      fetch: async (/** @type {Request} */ request) => {
        assetCalls += 1;
        return new Response(new URL(request.url).pathname, {
          headers: { "cache-control": "public, max-age=60" },
        });
      },
    },
    createApiWorker: () => {
      apiCompositions += 1;
      return { ok: true, value: { fetch: async () => new Response("api") } };
    },
  });
  assertEquals(result.ok, true);
  if (!result.ok) throw new Error(result.error.kind);

  for (const path of ["/", "/index.html", "/assets/app.js", "/missing"]) {
    const response = await result.value.fetch(
      new Request(`https://resonance.example${path}`),
    );
    assertEquals(await response.text(), path);
  }
  assertEquals(assetCalls, 4);
  assertEquals(apiCompositions, 0);
});

Deno.test("unified router sends API roots only to the uncached API worker", async () => {
  let assetCalls = 0;
  let apiCompositions = 0;
  let apiCalls = 0;
  const result = createUnifiedWorkerRouter({
    assets: {
      fetch: async () => {
        assetCalls += 1;
        return new Response("asset");
      },
    },
    createApiWorker: () => {
      apiCompositions += 1;
      return {
        ok: true,
        value: {
          fetch: async () => {
            apiCalls += 1;
            return new Response("api", {
              headers: { "cache-control": "no-store" },
            });
          },
        },
      };
    },
  });
  if (!result.ok) throw new Error(result.error.kind);

  for (const path of ["/api", "/api/", "/api/discovery/fresh"]) {
    const response = await result.value.fetch(
      new Request(`https://resonance.example${path}`),
    );
    assertEquals(await response.text(), "api");
    assertEquals(response.headers.get("cache-control"), "no-store");
  }
  assertEquals(assetCalls, 0);
  assertEquals(apiCompositions, 3);
  assertEquals(apiCalls, 3);
});

Deno.test("unified router returns named configuration failures", () => {
  const missingAssets = createUnifiedWorkerRouter({
    assets: undefined,
    createApiWorker: () => ({
      ok: true,
      value: { fetch: async () => new Response() },
    }),
  });
  assertEquals(missingAssets.ok, false);
  if (missingAssets.ok) throw new Error("Expected missing assets to fail.");
  assertEquals(missingAssets.error.kind, "UnifiedWorkerBindingInvalid");
  assertEquals(missingAssets.error.field, "ASSETS");

  const invalidFactory = createUnifiedWorkerRouter({
    assets: { fetch: async () => new Response() },
    createApiWorker: /** @type {never} */ (undefined),
  });
  assertEquals(invalidFactory.ok, false);
  if (invalidFactory.ok) throw new Error("Expected invalid factory to fail.");
  assertEquals(invalidFactory.error.kind, "UnifiedWorkerBindingInvalid");
  assertEquals(invalidFactory.error.field, "createApiWorker");
});

Deno.test("API composition failure is explicit and never falls through to assets", async () => {
  let assetCalls = 0;
  const result = createUnifiedWorkerRouter({
    assets: {
      fetch: async () => {
        assetCalls += 1;
        return new Response("asset");
      },
    },
    createApiWorker: () => ({
      ok: false,
      error: {
        kind: "DiscoveryDeploymentConfigurationMissing",
        field: "ACCESS_AUDIENCE",
      },
    }),
  });
  if (!result.ok) throw new Error(result.error.kind);
  const response = await result.value.fetch(
    new Request("https://resonance.example/api/discovery/fresh"),
  );
  assertEquals(response.status, 503);
  assertEquals(response.headers.get("cache-control"), "no-store");
  const payload = /** @type {unknown} */ (await response.json());
  assert(
    typeof payload === "object" && payload !== null &&
      "error" in payload &&
      payload.error === "DiscoveryDeploymentConfigurationMissing",
    "The API response must preserve the named composition failure.",
  );
  assertEquals(assetCalls, 0);
});
