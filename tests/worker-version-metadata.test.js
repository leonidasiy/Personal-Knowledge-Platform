// @ts-check

import { attachWorkerVersion } from "../worker/version-metadata.js";
import { routeWithWorkerVersion } from "../worker/versioned-router.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

Deno.test("Worker version metadata is required and attached", async () => {
  const attached = attachWorkerVersion(
    new Response("ok", {
      status: 201,
      statusText: "Created",
      headers: { "cache-control": "no-store" },
    }),
    { id: "version-a" },
  );
  assert(attached.ok, "Expected valid version metadata to be attached.");
  if (attached.ok) {
    assertEquals(
      attached.value.headers.get("x-resonance-worker-version"),
      "version-a",
    );
    assertEquals(attached.value.status, 201);
    assertEquals(attached.value.statusText, "Created");
    assertEquals(attached.value.headers.get("cache-control"), "no-store");
    assertEquals(await attached.value.text(), "ok");
  }

  for (const metadata of [undefined, null, {}, { id: "" }, { id: 1 }]) {
    const rejected = attachWorkerVersion(new Response("ok"), metadata);
    assert(!rejected.ok, "Expected invalid version metadata to be rejected.");
    if (!rejected.ok) {
      assertEquals(rejected.error.kind, "WorkerVersionMetadataInvalid");
      assertEquals(rejected.error.field, "id");
    }
  }
});

Deno.test("versioned routing decorates static, API, and configuration failure responses", async () => {
  const metadata = { id: "version-a" };
  const staticResponse = await routeWithWorkerVersion(
    {
      ok: true,
      value: { fetch: async () => new Response("asset", { status: 200 }) },
    },
    new Request("https://app.example/"),
    metadata,
  );
  assertEquals(staticResponse.status, 200);
  assertEquals(
    staticResponse.headers.get("x-resonance-worker-version"),
    "version-a",
  );
  assertEquals(await staticResponse.text(), "asset");

  const apiResponse = await routeWithWorkerVersion(
    {
      ok: true,
      value: { fetch: async () => new Response("api", { status: 200 }) },
    },
    new Request("https://app.example/api/discovery/fresh"),
    metadata,
  );
  assertEquals(apiResponse.status, 200);
  assertEquals(
    apiResponse.headers.get("x-resonance-worker-version"),
    "version-a",
  );
  assertEquals(await apiResponse.text(), "api");

  const failed = await routeWithWorkerVersion(
    {
      ok: false,
      error: { kind: "WorkerConfigurationInvalid", field: "ASSETS" },
    },
    new Request("https://app.example/"),
    metadata,
  );
  assertEquals(failed.status, 503);
  assertEquals(
    failed.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assertEquals(failed.headers.get("cache-control"), "no-store");
  assertEquals(failed.headers.get("x-resonance-worker-version"), "version-a");
  assertEquals(
    await failed.json(),
    { error: "WorkerConfigurationInvalid", field: "ASSETS" },
  );
});

Deno.test("versioned routing returns a named 503 without version data for invalid metadata", async () => {
  const response = await routeWithWorkerVersion(
    {
      ok: true,
      value: { fetch: async () => new Response("asset") },
    },
    new Request("https://app.example/"),
    { id: "" },
  );
  assertEquals(response.status, 503);
  assertEquals(response.headers.get("cache-control"), "no-store");
  assertEquals(response.headers.get("x-resonance-worker-version"), null);
  assertEquals(
    await response.json(),
    { error: "WorkerVersionMetadataInvalid", field: "id" },
  );
});
