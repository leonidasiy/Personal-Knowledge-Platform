import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createGate, pinnedRequest } from "../acquisition/gate.ts";
import { createRenderer, probeIsolation } from "../acquisition/renderer.ts";
import {
  createAcquisitionHandler,
  createAcquisitionServer,
} from "../acquisition/service.ts";
import {
  createAcquisitionClient,
  createAcquisitionWorkflowBrowser,
} from "../worker/acquisition-client.js";
import { ACQUISITION_POLICY as policy } from "../worker/acquisition-policy.js";
const bytes = new TextEncoder().encode(
  '<title>Fixture</title><main>Local lesson</main><a href="/next">Next</a>',
);
test("real TLS fixture cannot masquerade as public egress; real HTTP service/Worker/browser integration and screenshot evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acquisition-integration-"));
  let tls, server;
  const evidence = {
    scope:
      "Local isolated fixtures only. No public Internet/provider calls. Loopback is NOT a production public-safe override.",
    tlsRequests: [],
    workerRequests: [],
    ipIsolation: await probeIsolation(process.execPath),
  };
  try {
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=source.example",
      "-addext",
      "subjectAltName=DNS:source.example",
    ], { stdio: "ignore" });
    const ca = await readFile(join(dir, "cert.pem"), "utf8");
    tls = https.createServer({
      key: await readFile(join(dir, "key.pem")),
      cert: ca,
    }, (req, res) => {
      evidence.tlsRequests.push({
        host: req.headers.host,
        sni: req.socket.servername,
        path: req.url,
      });
      res.setHeader("content-type", "text/html");
      res.end(bytes);
    });
    await new Promise((r) => tls.listen(0, "127.0.0.1", r));
    // Test-only transposition deliberately preserves actual loopback peer evidence.
    const gate = createGate({
      policy,
      resolve: async () => ["8.8.8.8"],
      dial: async (url, address, signal) => {
        assert.equal(address, "8.8.8.8");
        const local = new URL(url);
        local.port = String(tls.address().port);
        return pinnedRequest(local, "127.0.0.1", signal, { ca });
      },
      logger: () => {},
    });
    const rejected = await gate.request(
      {
        url: "https://source.example/article",
        rootUrl: "https://source.example/",
        purpose: "page",
        maximumBytes: policy.htmlBytes,
        redirectLimit: 3,
      },
      { encoded: 0, decoded: 0, resources: 0, pixels: 0 },
      new AbortController().signal,
    );
    assert.equal(rejected.error.kind, "AddressRejected");
    assert.equal(rejected.error.field, "connected-peer");
    evidence.realTlsGateRejection = rejected;
    // Happy protocol/render fixtures provide explicit synthetic origin observations;
    // they do not constitute public connection enforcement evidence.
    const observations = [];
    const fixtureGate = {
      request: async (command) => {
        observations.push(command.url);
        return {
          ok: true,
          value: {
            peerAddress: "8.8.8.8",
            status: command.purpose === "robots" ? 404 : 200,
            headers: { "content-type": "text/html" },
            bytes: command.purpose === "robots" ? new Uint8Array() : bytes,
            finalUrl: command.url,
            redirectHops: [],
          },
        };
      },
    };
    const renderer = createRenderer({
      policy,
      chromePath:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      nodePath: process.execPath,
      platform: process.platform,
      request: fixtureGate.request,
    });
    const handler = createAcquisitionHandler({
      policy,
      tokens: new Map([["fixture-token-only", "fixture-client"]]),
      maximumActive: 2,
      maximumRetained: 100,
      retentionMilliseconds: 60000,
      nowMs: Date.now,
      logger: () => {},
      gate: fixtureGate,
      renderer,
    });
    server = createAcquisitionServer({
      policy,
      handler,
      transport: { kind: "loopback-fixture" },
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    let id = 0;
    const client = createAcquisitionClient({
      binding: {
        fetch: async (req) => {
          evidence.workerRequests.push({
            method: req.method,
            path: new URL(req.url).pathname,
          });
          const url = new URL(req.url);
          return fetch(
            `http://127.0.0.1:${server.address().port}${url.pathname}`,
            {
              method: req.method,
              headers: req.headers,
              body: req.method === "POST" ? await req.text() : undefined,
              signal: req.signal,
            },
          );
        },
      },
      endpoint: "https://fixture-service.test/",
      token: "fixture-token-only",
      policy,
      createId: () => `fixture-integration-${++id}`,
    });
    const browser = createAcquisitionWorkflowBrowser({
      client,
      policy,
      logger: () => ({ ok: true, value: null }),
    });
    const robots = await browser.readRobots({
      sourceUrl: "https://source.example/article",
      robotsUrl: "https://source.example/robots.txt",
    });
    assert.equal(robots.value.status, 404);
    const page = await browser.readPage({
      rootUrl: "https://source.example/",
      url: "https://source.example/article",
    });
    assert.equal(page.value.renderedText, "Local lesson");
    const shot = await browser.screenshot({
      rootUrl: "https://source.example/",
      url: "https://source.example/article",
    });
    assert.equal(shot.value.bytes[0], 137);
    assert.equal((await browser.close()).ok, true);
    assert.equal(
      (await browser.readPage({
        rootUrl: "https://source.example/",
        url: "https://source.example/article",
      })).error.kind,
      "KnowledgeBrowserClosed",
    );
    const native = await client.sourceBrowserRequest({
      url: "https://source.example/robots.txt",
      timeout: 1000,
    });
    assert.equal(native.status(), 404);
    assert.equal(native.url(), "https://source.example/robots.txt");
    assert.equal(typeof native.headers(), "object");
    assert.equal(await native.text(), "");
    evidence.syntheticObservationUrls = observations;
    evidence.screenshotBytes = shot.value.bytes.length;
    evidence.robotsStatus = robots.value.status;
    evidence.renderedText = page.value.renderedText;
    await mkdir("test-results/acquisition", { recursive: true });
    await writeFile(
      "test-results/acquisition/page-fixture.png",
      shot.value.bytes,
    );
    await writeFile(
      "test-results/acquisition/integration.json",
      JSON.stringify(evidence, null, 2),
    );
  } finally {
    tls?.closeAllConnections();
    server?.closeAllConnections();
    if (tls) await new Promise((r) => tls.close(r));
    if (server) await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
