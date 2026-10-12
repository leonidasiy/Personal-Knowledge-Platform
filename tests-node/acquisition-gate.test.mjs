import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import {
  createGate,
  pinnedRequest,
  publicAddress,
} from "../acquisition/gate.ts";
import { ACQUISITION_POLICY as policy } from "../worker/acquisition-policy.js";
const command = (changes = {}) => ({
  url: "https://source.example/article",
  rootUrl: "https://source.example/",
  purpose: "page",
  maximumBytes: 100,
  redirectLimit: 3,
  ...changes,
});
const budget = () => ({ encoded: 0, decoded: 0, resources: 0, pixels: 0 });
function response(body = "hello", status = 200, headers = {}) {
  const r = Readable.from([Buffer.from(body)]);
  r.statusCode = status;
  r.headers = { "content-type": "text/html", ...headers };
  return r;
}
function fixture(options = {}) {
  const contacts = [];
  const gate = createGate({
    policy,
    resolve: options.resolve ?? (async () => ["8.8.8.8"]),
    dial: async (url, address, signal) => {
      contacts.push({ url: url.href, address, signal });
      const r = options.dial
        ? await options.dial(url, address, signal)
        : response();
      r.socket ??= { remoteAddress: address };
      return r;
    },
    logger: () => {},
  });
  return { gate, contacts };
}
for (
  const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "2001::1",
    "2002:7f00:1::",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "3fff::1",
    "bad",
  ]
) {
  test(`no prohibited connection ${address}`, async () => {
    assert.equal(publicAddress(address), false);
    const f = fixture({ resolve: async () => [address] });
    assert.equal(
      (await f.gate.request(command(), budget(), new AbortController().signal))
        .error.kind,
      "AddressRejected",
    );
    assert.equal(f.contacts.length, 0);
  });
}
for (
  const [url, kind] of [
    ["http://source.example/", "HttpsRequired"],
    ["https://a:b@source.example/", "CredentialsRejected"],
    ["https://source.example:8443/", "PortRejected"],
    ["not-a-url", "UrlInvalid"],
    ["https://127.0.0.1/", "AddressRejected"],
    ["https://[::ffff:7f00:1]/", "AddressRejected"],
  ]
) {
  test(`reject ${kind} before DNS/dial`, async () => {
    let dns = 0;
    const f = fixture({
      resolve: async () => {
        dns++;
        return ["8.8.8.8"];
      },
    });
    assert.equal(
      (await f.gate.request(
        command({ url }),
        budget(),
        new AbortController().signal,
      )).error.kind,
      kind,
    );
    assert.equal(dns, 0);
    assert.equal(f.contacts.length, 0);
  });
}
test("mixed public/private DNS fails before first contact", async () => {
  const f = fixture({ resolve: async () => ["8.8.8.8", "10.0.0.1"] });
  assert.equal(
    (await f.gate.request(command(), budget(), new AbortController().signal))
      .error.kind,
    "AddressRejected",
  );
  assert.equal(f.contacts.length, 0);
});
test("DNS is resolved on each request/reconnect; no pooled socket", async () => {
  let n = 0;
  const f = fixture({
    resolve: async () => ++n === 1 ? ["8.8.8.8"] : ["127.0.0.1"],
  });
  assert.equal(
    (await f.gate.request(command(), budget(), new AbortController().signal))
      .ok,
    true,
  );
  assert.equal(
    (await f.gate.request(command(), budget(), new AbortController().signal))
      .error.kind,
    "AddressRejected",
  );
  assert.equal(f.contacts.length, 1);
});
test("all fallback addresses validated; fallback pins exact approved address", async () => {
  const f = fixture({
    resolve: async () => ["8.8.8.8", "1.1.1.1"],
    dial: async (_u, a) => {
      if (a === "8.8.8.8") {
        throw Object.assign(new Error("fixture"), { code: "ECONNREFUSED" });
      }
      return response();
    },
  });
  assert.equal(
    (await f.gate.request(command(), budget(), new AbortController().signal))
      .ok,
    true,
  );
  assert.deepEqual(f.contacts.map((x) => x.address), ["8.8.8.8", "1.1.1.1"]);
});
test("redirect rebinding is rejected before second connection", async () => {
  let n = 0;
  const f = fixture({
    resolve: async () => ++n === 1 ? ["8.8.8.8"] : ["10.0.0.1"],
    dial: async () => response("", 302, { location: "/next" }),
  });
  assert.equal(
    (await f.gate.request(command(), budget(), new AbortController().signal))
      .error.kind,
    "AddressRejected",
  );
  assert.equal(f.contacts.length, 1);
});
for (
  const [location, kind] of [
    ["https://127.0.0.1/", "AddressRejected"],
    ["https://other.example/", "ScopeRejected"],
    ["https://u:p@source.example/", "CredentialsRejected"],
    ["http://source.example/", "HttpsRequired"],
    ["https://source.example:444/", "PortRejected"],
  ]
) {
  test(`redirect ${kind} never contacted`, async () => {
    const f = fixture({ dial: async () => response("", 302, { location }) });
    assert.equal(
      (await f.gate.request(command(), budget(), new AbortController().signal))
        .error.kind,
      kind,
    );
    assert.equal(f.contacts.length, 1);
  });
}
test("robots redirect rejected and observations 403/404/410 retained", async () => {
  for (const status of [403, 404, 410, 302]) {
    const f = fixture({
      dial: async () => response("", status, { location: "/else" }),
    });
    const result = await f.gate.request(
      command({
        url: "https://source.example/robots.txt",
        purpose: "robots",
        redirectLimit: 0,
      }),
      budget(),
      new AbortController().signal,
    );
    assert.equal(
      status === 302 ? result.error.kind : result.value.status,
      status === 302 ? "RedirectRejected" : status,
    );
    assert.equal(f.contacts.length, 1);
  }
});
test("redirect limit stops exact next hop", async () => {
  const f = fixture({
    dial: async () => response("", 302, { location: "/next" }),
  });
  assert.equal(
    (await f.gate.request(
      command({ redirectLimit: 1 }),
      budget(),
      new AbortController().signal,
    )).error.kind,
    "RedirectLimitExceeded",
  );
  assert.equal(f.contacts.length, 2);
});
for (
  const [encoding, encode] of [["gzip", gzipSync], ["br", brotliCompressSync], [
    "deflate",
    deflateSync,
  ]]
) {
  test(`real streaming ${encoding} equality and decoded +1`, async () => {
    for (const size of [100, 101]) {
      const f = fixture({
        dial: async () =>
          response(encode(Buffer.alloc(size, 65)), 200, {
            "content-encoding": encoding,
          }),
      });
      const result = await f.gate.request(
        command(),
        budget(),
        new AbortController().signal,
      );
      if (size === 100) assert.equal(result.value.bytes.length, 100);
      else assert.equal(result.error.kind, "DecodedLimitExceeded");
    }
  });
}
test("encoded resource and operation limits terminate reader", async () => {
  const f = fixture({ dial: async () => response(Buffer.alloc(101)) });
  assert.equal(
    (await f.gate.request(command(), budget(), new AbortController().signal))
      .error.kind,
    "EncodedLimitExceeded",
  );
  const b = budget();
  b.encoded = policy.encodedOperationBytes;
  assert.equal(
    (await fixture().gate.request(command(), b, new AbortController().signal))
      .error.kind,
    "OperationLimitExceeded",
  );
});
test("unknown encoding and malformed compressed bytes fail explicitly", async () => {
  for (
    const [encoding, kind] of [["compress", "EncodingUnsupported"], [
      "gzip",
      "DecodeFailed",
    ]]
  ) {
    const f = fixture({
      dial: async () =>
        response("broken", 200, { "content-encoding": encoding }),
    });
    assert.equal(
      (await f.gate.request(command(), budget(), new AbortController().signal))
        .error.kind,
      kind,
    );
  }
});
test("cancel before DNS and during body closes resources", async () => {
  const c = new AbortController();
  c.abort();
  const f = fixture();
  assert.equal(
    (await f.gate.request(command(), budget(), c.signal)).error.kind,
    "Cancelled",
  );
  assert.equal(f.contacts.length, 0);
  let r;
  const running = fixture({
    dial: async () => {
      r = new Readable({ read() {} });
      r.statusCode = 200;
      r.headers = {};
      return r;
    },
  });
  const c2 = new AbortController();
  const pending = running.gate.request(command(), budget(), c2.signal);
  await new Promise((r) => setTimeout(r, 20));
  c2.abort();
  assert.equal((await pending).error.kind, "Cancelled");
  assert.equal(r.destroyed, true);
});
test("public address positives and config malformed named", () => {
  for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(publicAddress(a), true);
  }
  assert.throws(
    () =>
      createGate({
        policy: { ...policy, resources: 0 },
        resolve: async () => [],
        dial: async () => response(),
        logger: () => {},
      }),
    /ConfigurationInvalid/,
  );
  assert.equal(typeof pinnedRequest, "function");
});
test("connected private or mismatched peer is never accepted as a public-safe fixture override", async () => {
  for (const peer of ["127.0.0.1", "1.1.1.1"]) {
    const f = fixture({
      dial: async () => {
        const r = response();
        r.socket = { remoteAddress: peer };
        return r;
      },
    });
    const result = await f.gate.request(
      command(),
      budget(),
      new AbortController().signal,
    );
    assert.equal(result.error.kind, "AddressRejected");
    assert.equal(result.error.field, "connected-peer");
  }
});
test("resource count and decoded whole-operation equality/+1 are enforced", async () => {
  for (const field of ["resources", "decoded"]) {
    const b = budget();
    b[field] = field === "resources"
      ? policy.resources - 1
      : policy.decodedOperationBytes - 5;
    const f = fixture();
    assert.equal(
      (await f.gate.request(command(), b, new AbortController().signal)).ok,
      true,
    );
    assert.equal(
      (await f.gate.request(command(), b, new AbortController().signal)).error
        .kind,
      "OperationLimitExceeded",
    );
  }
});
test("DNS failure and timeout stop before dialing, malformed command never resolves", async () => {
  const f = fixture({
    resolve: async () => {
      throw new Error("fixture DNS failure");
    },
  });
  assert.equal(
    (await f.gate.request(command(), budget(), new AbortController().signal))
      .error.kind,
    "DnsFailed",
  );
  assert.equal(f.contacts.length, 0);
  const timed = createGate({
    policy: { ...policy, requestMilliseconds: 20 },
    resolve: async (_h, s) =>
      new Promise((_, reject) =>
        s.addEventListener("abort", () => reject(new Error("abort")), {
          once: true,
        })
      ),
    dial: async () => {
      throw new Error("no contact");
    },
    logger: () => {},
  });
  const keep = setInterval(() => {}, 100);
  try {
    assert.equal(
      (await timed.request(command(), budget(), new AbortController().signal))
        .error.kind,
      "TimedOut",
    );
  } finally {
    clearInterval(keep);
  }
});
