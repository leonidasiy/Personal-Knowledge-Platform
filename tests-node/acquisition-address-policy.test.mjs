import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createAddressPolicy, createGate, publicUrl } from "../acquisition/gate.ts";
import { ACQUISITION_POLICY as policy } from "../worker/acquisition-policy.js";

const directory = new URL("../acquisition/iana/", import.meta.url);
const json = (name) => JSON.parse(readFileSync(new URL(name, directory), "utf8"));

test("offline source validator, XML security and exact regeneration", () => {
  const result = spawnSync("python3", [fileURLToPath(new URL("test_policy.py", directory))], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("retained source bytes and generated metadata are pinned", () => {
  const generated = json("policy.json");
  const snapshots = json("snapshots.json");
  assert.equal(generated.registries.length, 2);
  for (const registry of generated.registries) {
    const metadata = snapshots.sources.find((item) => item.family === registry.family);
    const bytes = readFileSync(new URL(registry.file, directory));
    assert.equal(registry.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(registry.bytes, bytes.length);
    assert.equal(registry.url, `https://www.iana.org/assignments/iana-ipv${registry.family}-special-registry/iana-ipv${registry.family}-special-registry.xml`);
    assert.match(registry.retrievedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(registry.retrievedAt, metadata.retrievedAt);
    assert.equal(registry.revision, "2025-10-09");
  }
});

// These new endpoints are read from the retrieved special-purpose records,
// including global=True entries; the policy rejects special assignments wholesale.
for (const address of ["192.31.196.0", "192.31.196.255", "192.52.193.0", "192.52.193.255", "192.175.48.0", "192.175.48.255", "2620:4f:8000::", "2620:4f:8000:ffff:ffff:ffff:ffff:ffff"]) {
  test(`registered special address ${address} rejected at literal and DNS gates`, async () => {
    assert.equal(createAddressPolicy()(address), false);
    const literal = address.includes(":") ? `[${address}]` : address;
    assert.equal(publicUrl(`https://${literal}/`, policy.urlCharacters).error.kind, "AddressRejected");
    let contacts = 0;
    const gate = createGate({ policy, resolve: async () => ["8.8.8.8", address], dial: async () => { contacts++; throw new Error("ForbiddenDial"); }, logger: () => {} });
    const budget = { encoded: 0, decoded: 0, resources: 0, pixels: 0 };
    const result = await gate.request({ url: "https://source.example/", rootUrl: "https://source.example/", purpose: "page", maximumBytes: 100, redirectLimit: 0 }, budget, new AbortController().signal);
    assert.equal(result.error.kind, "AddressRejected");
    assert.equal(contacts, 0);
  });
}

test("every source-derived prefix rejects first and last; public families remain usable", () => {
  const generated = json("policy.json");
  const allowed = createAddressPolicy();
  for (const registry of generated.registries) {
    for (const record of registry.records) {
      for (const block of record.blocks) {
        assert.equal(allowed(block.first), false, `${record.name}: ${block.cidr} first`);
        assert.equal(allowed(block.last), false, `${record.name}: ${block.cidr} last`);
      }
    }
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2000::", "3fff:1000::"]) assert.equal(allowed(address), true, address);
  for (const address of ["224.0.0.0", "239.255.255.255", "240.0.0.0", "255.255.255.255", "4000::", "::ffff:8.8.8.8", "bad", "", null, {}, 1]) assert.equal(allowed(address), false);
  assert.equal(allowed("223.255.255.255"), true);
});


test("missing registry or record fails closed before policy construction", async () => {
  const { default: artifact } = await import("../acquisition/iana/policy.json", { with: { type: "json" } });
  const removedRegistry = artifact.registries.pop();
  try { assert.throws(() => createAddressPolicy(), /AddressPolicyInvalid: registries/); }
  finally { artifact.registries.push(removedRegistry); }
  const removedRecord = artifact.registries[0].records.pop();
  try { assert.throws(() => createAddressPolicy(), /AddressPolicyInvalid: incomplete-registry/); }
  finally { artifact.registries[0].records.push(removedRecord); }
});
