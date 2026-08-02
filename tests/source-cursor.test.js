// @ts-check

import { createSourceCursorCodec } from "../worker/source-cursor.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

Deno.test("source cursors round-trip and reject tampering", async () => {
  const codec = createSourceCursorCodec("a".repeat(32), crypto.subtle);
  const encoded = await codec.encode({
    ownerId: "owner-a",
    approvedAt: "2026-07-22T10:00:00.000Z",
    sourceId: "source-a",
    catalogRevision: "3:latest",
  });
  assertEquals(encoded.ok, true);
  if (!encoded.ok) throw new Error(encoded.error.kind);
  const decoded = await codec.decode(encoded.value);
  assertEquals(decoded.ok, true);
  if (!decoded.ok) throw new Error(decoded.error.kind);
  assertEquals(decoded.value.ownerId, "owner-a");

  const tampered = `${encoded.value.slice(0, -1)}${
    encoded.value.endsWith("a") ? "b" : "a"
  }`;
  const rejected = await codec.decode(tampered);
  assertEquals(rejected.ok, false);
  if (rejected.ok) throw new Error("Expected tampered cursor rejection.");
  assertEquals(rejected.error.kind, "SourceCursorInvalid");
});

Deno.test("source cursor codec rejects malformed payloads and weak secrets", async () => {
  let threw = false;
  try {
    createSourceCursorCodec("short", crypto.subtle);
  } catch (error) {
    if (error instanceof TypeError) threw = true;
    else throw error;
  }
  assertEquals(threw, true);
  const codec = createSourceCursorCodec("b".repeat(32), crypto.subtle);
  const malformed = await codec.decode("not-a-cursor");
  assertEquals(malformed.ok, false);
});
