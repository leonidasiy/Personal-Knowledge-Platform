// @ts-check

import { isForbiddenAddress, resolvePublicAddresses } from "../worker/knowledge-workflow-network.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) { if (!Object.is(actual, expected)) throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`); }

Deno.test("network policy rejects private, loopback, reserved, and documentation addresses", () => {
  for (const address of ["0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.1.1", "192.168.1.1", "::1", "fc00::1", "2001:db8::1"]) assertEquals(isForbiddenAddress(address), true);
  assertEquals(isForbiddenAddress("93.184.216.34"), false);
});

Deno.test("network policy requires DNS answers and rejects private answers before acquisition", async () => {
  const privateResult = await resolvePublicAddresses("example.test", async (input) => new Response(JSON.stringify({ Status: 0, Answer: [{ type: String(input).includes("AAAA") ? 28 : 1, data: String(input).includes("AAAA") ? "2001:db8::1" : "192.168.1.1" }] })));
  assertEquals(privateResult.ok, false);
  if (!privateResult.ok) assertEquals(privateResult.error.kind, "WorkflowPrivateAddressRejected");
  const emptyResult = await resolvePublicAddresses("example.test", async () => new Response(JSON.stringify({ Status: 3 })));
  assertEquals(emptyResult.ok, false);
  if (!emptyResult.ok) assertEquals(emptyResult.error.kind, "WorkflowDnsLookupFailed");
  const publicResult = await resolvePublicAddresses("example.test", async (input) => new Response(JSON.stringify({ Status: 0, Answer: [{ type: String(input).includes("AAAA") ? 28 : 1, data: String(input).includes("AAAA") ? "2606:4700:4700::1111" : "93.184.216.34" }] })));
  assertEquals(publicResult.ok, true);
  if (publicResult.ok) assertEquals(publicResult.value.length, 2);
});

Deno.test('serialized browser address policy has no dependency on bundle-local helpers', () => {
  const isolated = new Function(`return (${isForbiddenAddress.toString()});`)();
  for (const [address, forbidden] of [
    ['8.8.8.8', false], ['2606:4700:4700::1111', false],
    ['127.0.0.1', true], ['192.168.1.1', true], ['::ffff:127.0.0.1', true], ['', true],
  ]) assertEquals(isolated(address), forbidden);
});
