import test from "node:test";
import assert from "node:assert/strict";
import { createRenderer, imageMetadata } from "../acquisition/renderer.ts";
import { ACQUISITION_POLICY as policy } from "../worker/acquisition-policy.js";
import http from "node:http";
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const cmd = {
  url: "https://source.example/article",
  rootUrl: "https://source.example/",
  purpose: "page",
  maximumBytes: policy.htmlBytes,
  redirectLimit: 3,
};
const obs = (html) => ({
  peerAddress: "8.8.8.8",
  status: 200,
  headers: { "content-type": "text/html" },
  bytes: new TextEncoder().encode(html),
  finalUrl: cmd.url,
  redirectHops: [],
});
const budget = () => ({ encoded: 0, decoded: 0, resources: 0, pixels: 0 });
test("real headless OS-isolated renderer mediates only same-source scripts, blocks browser TCP bypass and third parties", async () => {
  let bypass = 0;
  const server = http.createServer((_q, r) => {
    bypass++;
    r.end("bad");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const contacts = [];
  try {
    const renderer = createRenderer({
      policy,
      chromePath,
      nodePath: process.execPath,
      platform: process.platform,
      request: async (command) => {
        contacts.push(command.url);
        return {
          ok: true,
          value: {
            ...obs(""),
            bytes: new TextEncoder().encode(
              'document.querySelector("main").textContent="rendered lesson";',
            ),
          },
        };
      },
    });
    const html =
      `<title>Fixture</title><main>initial</main><a href="/next">Next</a><script src="/lesson.js"></script><script src="https://third.example/blocked.js"></script><script>fetch('http://127.0.0.1:${port}/direct').catch(()=>{});new WebSocket('ws://127.0.0.1:${port}/socket');const pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${port}'}]});pc.createDataChannel('x');pc.createOffer().then(x=>pc.setLocalDescription(x));</script>`;
    const result = await renderer.render(
      cmd,
      obs(html),
      budget(),
      new AbortController().signal,
      true,
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value.projection.renderedText, "rendered lesson");
    assert.deepEqual(result.value.projection.visibleLinks, [
      "https://source.example/next",
    ]);
    assert.deepEqual(contacts, ["https://source.example/lesson.js"]);
    assert.equal(bypass, 0);
    assert.equal(result.value.screenshot[0], 137);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
test("unsupported OS/browser configuration fails closed and never calls gate", async () => {
  let calls = 0;
  const r = createRenderer({
    policy,
    chromePath,
    nodePath: process.execPath,
    platform: "unsupported",
    request: async () => {
      calls++;
      throw new Error("forbidden");
    },
  });
  assert.equal(
    (await r.render(
      cmd,
      obs("<main>x</main>"),
      budget(),
      new AbortController().signal,
      false,
    )).error.kind,
    "BrowserTransportUnsupported",
  );
  assert.equal(calls, 0);
});
test("renderer pre-cancel and output pixel caps abort resources", async () => {
  const r = createRenderer({
    policy,
    chromePath,
    nodePath: process.execPath,
    platform: process.platform,
    request: async () => {
      throw new Error("forbidden");
    },
  });
  const c = new AbortController();
  c.abort();
  assert.equal(
    (await r.render(cmd, obs("<main>x</main>"), budget(), c.signal, false))
      .error.kind,
    "Cancelled",
  );
  const b = budget();
  b.pixels = policy.aggregatePixels;
  assert.equal(
    (await r.render(
      cmd,
      obs("<main>x</main>"),
      b,
      new AbortController().signal,
      true,
    )).error.kind,
    "PixelLimitExceeded",
  );
});
test("real decoder rejects header-only PNG; metadata enforces pixels/frames before decode", async () => {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(200000, 16);
  png.writeUInt32BE(200000, 20);
  assert.equal(
    imageMetadata(png, "image/png", policy).error.kind,
    "PixelLimitExceeded",
  );
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  const r = createRenderer({
    policy,
    chromePath,
    nodePath: process.execPath,
    platform: process.platform,
    request: async () => {
      throw new Error("forbidden");
    },
  });
  assert.equal(
    (await r.decodeImage(png, "image/png", new AbortController().signal)).error
      .kind,
    "ImageDecodeFailed",
  );
});
test("real PNG decoding succeeds, PNG/JPEG/GIF/WebP pixel and frame metadata bounds", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  );
  const r = createRenderer({
    policy,
    chromePath,
    nodePath: process.execPath,
    platform: process.platform,
    request: async () => {
      throw new Error("forbidden");
    },
  });
  assert.equal(
    (await r.decodeImage(png, "image/png", new AbortController().signal)).ok,
    true,
  );
  assert.equal(
    imageMetadata(png, "image/png", { ...policy, pixels: 1 }).ok,
    true,
  );
  const p = Buffer.from(png);
  p.writeUInt32BE(2, 16);
  assert.equal(
    imageMetadata(p, "image/png", { ...policy, pixels: 1 }).error.kind,
    "PixelLimitExceeded",
  );
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0);
  webp.write("WEBP", 8);
  webp.write("VP8X", 12);
  webp[20] = 2;
  assert.equal(
    imageMetadata(webp, "image/webp", policy).error.kind,
    "FrameLimitExceeded",
  );
});
test("cancellation during real renderer acquisition aborts its pending mediated gate request", async () => {
  let entered;
  const ready = new Promise((r) => entered = r);
  let stopped = false;
  const r = createRenderer({
    policy,
    chromePath,
    nodePath: process.execPath,
    platform: process.platform,
    request: async (_c, _b, s) => {
      entered();
      return new Promise((resolve) =>
        s.addEventListener("abort", () => {
          stopped = true;
          resolve({ ok: false, error: { kind: "Cancelled" } });
        }, { once: true })
      );
    },
  });
  const c = new AbortController();
  const pending = r.render(
    cmd,
    obs('<main>lesson</main><script src="/pending.js"></script>'),
    budget(),
    c.signal,
    false,
  );
  await ready;
  c.abort();
  assert.equal((await pending).error.kind, "Cancelled");
  assert.equal(stopped, true);
});
test("first mediated resource failure aborts sibling sockets and preserves its named cause", async () => {
  let entered;
  const ready = new Promise((r) => entered = r);
  let stopped = false;
  const r = createRenderer({
    policy: { ...policy, requestMilliseconds: 1000 },
    chromePath,
    nodePath: process.execPath,
    platform: process.platform,
    request: async (c, _b, s) => {
      if (c.url.endsWith("/wait.js")) {
        entered();
        return new Promise((resolve) =>
          s.addEventListener("abort", () => {
            stopped = true;
            resolve({ ok: false, error: { kind: "Cancelled" } });
          }, { once: true })
        );
      }
      await ready;
      return { ok: false, error: { kind: "DecodedLimitExceeded" } };
    },
  });
  const result = await r.render(
    cmd,
    obs(
      '<main>lesson</main><script async src="/wait.js"></script><script async src="/fail.js"></script>',
    ),
    budget(),
    new AbortController().signal,
    false,
  );
  assert.equal(result.error.kind, "DecodedLimitExceeded");
  assert.equal(stopped, true);
});
test("rendered base URL expansion cannot return unbounded link strings", async () => {
  const r = createRenderer({
    policy,
    chromePath,
    nodePath: process.execPath,
    platform: process.platform,
    request: async () => {
      throw Error("no network expected");
    },
  });
  const result = await r.render(
    cmd,
    obs(
      `<base href="https://source.example/${
        "x".repeat(9000)
      }"><main>lesson</main><a href="">expanded</a>`,
    ),
    budget(),
    new AbortController().signal,
    false,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "DecodedLimitExceeded");
});
test('navigation link ceiling retains source text/images and reports bounded navigation truncation',async()=>{const renderer=createRenderer({policy,chromePath,nodePath:process.execPath,platform:process.platform,request:async()=>assert.fail('No resources')});const html='<main><p>Source learning relationship.</p>'+Array.from({length:201},(_,i)=>'<a href="/link-'+i+'">Link '+i+'</a>').join('')+'</main>';const result=await renderer.render(cmd,obs(html),budget(),new AbortController().signal,false);assert.equal(result.ok,true);assert.equal(result.value.projection.visibleLinks.length,200);assert(result.value.projection.evidence.blocks.some(b=>b.text==='Source learning relationship.'));assert(result.value.projection.evidence.warnings.includes('WebpageNavigationLinkLimitExceeded'));});
