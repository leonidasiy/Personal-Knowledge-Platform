import test from "node:test";
import assert from "node:assert/strict";
import {
  createAcquisitionHandler,
  createAcquisitionServer,
} from "../acquisition/service.ts";
import { ACQUISITION_POLICY as policy } from "../worker/acquisition-policy.js";
const request = {
  url: "https://source.example/article",
  rootUrl: "https://source.example/",
  purpose: "page",
  maximumBytes: 100,
  redirectLimit: 3,
};
const observation = {
  peerAddress: "8.8.8.8",
  status: 200,
  headers: { "content-type": "text/html" },
  bytes: new TextEncoder().encode("<main>fixture</main>"),
  finalUrl: request.url,
  redirectHops: [],
};
const options = (overrides = {}) => ({
  policy,
  tokens: new Map([["fixture-token-a", "client-a"], [
    "fixture-token-b",
    "client-b",
  ]]),
  maximumActive: 2,
  maximumRetained: 100,
  retentionMilliseconds: 60000,
  nowMs: () => Date.now(),
  logger: () => {},
  gate: { request: async () => ({ ok: true, value: observation }) },
  renderer: {
    render: async () => ({
      ok: true,
      value: {
        projection: {
          html: "<main>fixture</main>",
          renderedTitle: "Fixture",
          renderedText: "fixture",
          visibleLinks: [],
        },
      },
    }),
    decodeImage: async () => ({ ok: true, value: null }),
  },
  ...overrides,
});
const message = (
  id = "fixture-id-0001",
  token = "fixture-token-a",
  body = { action: "request", request },
  method = "POST",
) =>
  new Request(`https://service.test/v1/operations/${id}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
test("auth/malformed transport variants never call acquisition", async () => {
  let calls = 0;
  const handle = createAcquisitionHandler(
    options({
      gate: {
        request: async () => {
          calls++;
          return { ok: true, value: observation };
        },
      },
    }),
  );
  for (
    const req of [
      message(undefined, "wrong"),
      new Request("https://service.test/v1/operations/fixture-id-0001", {
        method: "POST",
      }),
      message("bad"),
      message("fixture-id-0001", "fixture-token-a", {
        action: "request",
        request,
        secret: "reject",
      }),
      message("fixture-id-0002", "fixture-token-a", {
        action: "unknown",
        request,
      }),
    ]
  ) {
    const r = await (await handle(req)).json();
    assert.equal(r.ok, false);
  }
  assert.equal(calls, 0);
});
test("successful wire provenance, no credential response headers, same ID replay conflict", async () => {
  const handle = createAcquisitionHandler(options());
  const response = await handle(message());
  assert.equal(response.status, 200);
  const r = await response.json();
  assert.equal(r.ok, true);
  assert.equal(
    Buffer.from(r.value.bodyBase64, "base64").toString(),
    "<main>fixture</main>",
  );
  assert.equal(r.value.finalUrl, request.url);
  assert.equal(
    (await (await handle(message())).json()).error.kind,
    "OperationConflict",
  );
});
test("actual HTTP server authenticated request/disconnect maps to handler cancellation", async () => {
  let aborted = false;
  let entered, cancelled;
  const ready = new Promise(resolve => entered = resolve);
  const finished = new Promise(resolve => cancelled = resolve);
  const server = createAcquisitionServer({
    policy,
    handler: createAcquisitionHandler(options({
      gate: {
        request: async (_c, _b, signal) => {
          entered();
          return new Promise((resolve) =>
            signal.addEventListener("abort", () => {
              aborted = true;
              cancelled();
              resolve({ ok: false, error: { kind: "Cancelled" } });
            }, { once: true })
          );
        },
      },
    })),
    transport: { kind: "loopback-fixture" },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const c = new AbortController();
    const pending = fetch(
      `http://127.0.0.1:${server.address().port}/v1/operations/fixture-id-0001`,
      {
        method: "POST",
        headers: { authorization: "Bearer fixture-token-a" },
        body: JSON.stringify({ action: "request", request }),
        signal: c.signal,
      },
    ).catch((e) => e);
    await ready;
    c.abort();
    await pending;
    await finished;
    assert.equal(aborted, true);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
test("explicit authenticated cancel terminates gate; other principal cannot cancel it", async () => {
  let entered;
  const ready = new Promise((r) => entered = r);
  let aborted = false;
  const handle = createAcquisitionHandler(options({
    gate: {
      request: async (_c, _b, signal) => {
        entered();
        return new Promise((resolve) =>
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ ok: false, error: { kind: "Cancelled" } });
          }, { once: true })
        );
      },
    },
  }));
  const pending = handle(message());
  await ready;
  assert.equal(
    (await (await handle(
      message(undefined, "fixture-token-b", undefined, "DELETE"),
    )).json()).error.kind,
    "OperationNotFound",
  );
  assert.equal(aborted, false);
  assert.equal(
    (await (await handle(
      message(undefined, "fixture-token-a", undefined, "DELETE"),
    )).json()).ok,
    true,
  );
  assert.equal((await (await pending).json()).error.kind, "Cancelled");
  assert.equal(aborted, true);
});
test("cancel-before-start tombstone and active operation cap", async () => {
  const handle = createAcquisitionHandler(options());
  await handle(message(undefined, "fixture-token-a", undefined, "DELETE"));
  assert.equal(
    (await (await handle(message())).json()).error.kind,
    "Cancelled",
  );
});
for (
  const [status, kind] of [
    [401, "KnowledgePageAuthenticationRequired"],
    [402, "KnowledgePagePaywallDetected"],
    [403, "KnowledgePageBotAccessDenied"],
    [429, "KnowledgePageRateLimited"],
    [500, "KnowledgePageFetchFailed"],
  ]
) {
  test(`page restriction ${status} preserved without renderer`, async () => {
    let rendered = 0;
    const h = createAcquisitionHandler(options({
      gate: {
        request: async () => ({ ok: true, value: { ...observation, status } }),
      },
      renderer: {
        render: async () => {
          rendered++;
          throw Error("forbidden");
        },
        decodeImage: async () => ({ ok: true, value: null }),
      },
    }));
    assert.equal(
      (await (await h(
        message(undefined, undefined, { action: "page", request }),
      )).json()).error.kind,
      kind,
    );
    assert.equal(rendered, 0);
  });
}
test("operation deadline aborts underlying gate", async () => {
  let stopped = false;
  const h = createAcquisitionHandler(options({
    policy: { ...policy, operationMilliseconds: 30 },
    gate: {
      request: async (_c, _b, signal) =>
        new Promise((resolve) =>
          signal.addEventListener("abort", () => {
            stopped = true;
            resolve({ ok: false, error: { kind: "TimedOut" } });
          }, { once: true })
        ),
    },
  }));
  const keepAlive = setInterval(() => {}, 100);
  try {
    assert.equal((await (await h(message())).json()).error.kind, "TimedOut");
    assert.equal(stopped, true);
  } finally {
    clearInterval(keepAlive);
  }
});
test("active cap rejects another operation and cancellation ack follows renderer cleanup", async () => {
  let entered;
  const ready = new Promise((r) => entered = r);
  let stopped = false;
  const handle = createAcquisitionHandler(options({
    maximumActive: 1,
    renderer: {
      render: async (_c, _o, _b, s) => {
        entered();
        await new Promise((r) =>
          s.addEventListener("abort", r, { once: true })
        );
        await new Promise((r) => setTimeout(r, 30));
        stopped = true;
        return { ok: false, error: { kind: "Cancelled" } };
      },
      decodeImage: async () => ({ ok: true, value: null }),
    },
  }));
  const pending = handle(
    message(undefined, undefined, { action: "page", request }),
  );
  await ready;
  assert.equal(
    (await (await handle(message("fixture-id-0002"))).json()).error.kind,
    "OperationLimitExceeded",
  );
  await handle(message(undefined, undefined, undefined, "DELETE"));
  assert.equal(stopped, true);
  assert.equal((await (await pending).json()).error.kind, "Cancelled");
});
