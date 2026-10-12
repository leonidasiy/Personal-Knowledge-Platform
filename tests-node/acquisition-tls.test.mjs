import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pinnedRequest } from "../acquisition/gate.ts";
test("real fixture TLS pins IP, keeps SNI/Host and verifies CA plus hostname; credentials never forwarded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acquisition-tls-"));
  let server;
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
    const key = await readFile(join(dir, "key.pem"));
    const ca = await readFile(join(dir, "cert.pem"));
    const seen = [];
    server = https.createServer({ key, cert: ca }, (req, res) => {
      seen.push({
        host: req.headers.host,
        sni: req.socket.servername,
        authorization: req.headers.authorization,
        cookie: req.headers.cookie,
        peer: req.socket.remoteAddress,
      });
      res.setHeader("set-cookie", "fixture=private");
      res.end("hello");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const url = new URL(`https://source.example:${port}/`);
    const r = await pinnedRequest(
      url,
      "127.0.0.1",
      new AbortController().signal,
      { ca },
    );
    let body = "";
    for await (const c of r) body += c;
    assert.equal(body, "hello");
    assert.deepEqual(
      seen.map((x) => ({
        host: x.host,
        sni: x.sni,
        authorization: x.authorization,
        cookie: x.cookie,
      })),
      [{
        host: `source.example:${port}`,
        sni: "source.example",
        authorization: undefined,
        cookie: undefined,
      }],
    );
    await assert.rejects(
      pinnedRequest(
        new URL(`https://wrong.example:${port}/`),
        "127.0.0.1",
        new AbortController().signal,
        { ca },
      ),
      (e) => e.code === "ERR_TLS_CERT_ALTNAME_INVALID",
    );
    await assert.rejects(
      pinnedRequest(url, "127.0.0.1", new AbortController().signal),
      (e) => e.code === "DEPTH_ZERO_SELF_SIGNED_CERT",
    );
    assert.equal(seen.length, 1);
  } finally {
    server?.closeAllConnections();
    if (server) await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
