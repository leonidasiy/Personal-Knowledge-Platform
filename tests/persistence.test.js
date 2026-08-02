// @ts-check

import { MemoryPersistence } from "../src/persistence/memory.js";
import { RECORD_KINDS } from "../src/persistence/contracts.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

const event = Object.freeze({
  id: "event-1",
  ownerId: "owner-a",
  kind: /** @type {const} */ ("preference_event"),
  payloadJson: JSON.stringify({ choice: "more" }),
  recordedAt: "2026-07-19T00:00:00.000Z",
});

Deno.test("persistence round-trips an owner-scoped typed envelope", async () => {
  const persistence = new MemoryPersistence();
  assertEquals((await persistence.append(event)).ok, true);
  const listed = await persistence.list("owner-a", "preference_event");
  assertEquals(listed.ok, true);
  if (listed.ok) {
    assertEquals(listed.value.length, 1);
    assertEquals(listed.value[0].payloadJson, event.payloadJson);
  }
});

Deno.test("persistence rejects duplicate immutable records", async () => {
  const persistence = new MemoryPersistence();
  await persistence.append(event);
  const duplicate = await persistence.append(event);
  assertEquals(duplicate.ok, false);
  if (!duplicate.ok) assertEquals(duplicate.error.kind, "PersistenceDuplicate");
});

Deno.test("persistence isolates records by owner and kind", async () => {
  const persistence = new MemoryPersistence();
  await persistence.append(event);
  assertEquals(
    (await persistence.list("owner-b", "preference_event")).ok,
    true,
  );
  const otherOwner = await persistence.list("owner-b", "preference_event");
  const otherKind = await persistence.list("owner-a", "review_event");
  const manualStudy = await persistence.list("owner-a", "manual_study");
  if (otherOwner.ok) assertEquals(otherOwner.value.length, 0);
  if (otherKind.ok) assertEquals(otherKind.value.length, 0);
  if (manualStudy.ok) assertEquals(manualStudy.value.length, 0);
});

Deno.test("milestone 2C learning records round-trip by their typed kind", async () => {
  const persistence = new MemoryPersistence();
  const kinds = /** @type {const} */ ([
    "daily_learning_settings",
    "daily_study_set",
    "prompt_generation",
    "daily_recall_cohort",
    "grade_finalization",
  ]);
  for (const [index, kind] of kinds.entries()) {
    const appended = await persistence.append({
      id: `learning-${index}`,
      ownerId: "owner-a",
      kind,
      payloadJson: JSON.stringify({ revision: index + 1 }),
      recordedAt: "2026-07-20T00:00:00.000Z",
    });
    assertEquals(appended.ok, true);
    const listed = await persistence.list("owner-a", kind);
    assertEquals(listed.ok, true);
    if (listed.ok) assertEquals(listed.value.length, 1);
  }
});

Deno.test("runtime record kinds include every Milestone 3 discovery record", () => {
  const discoveryKinds = [
    "discovery_source",
    "discovery_run",
    "discovery_item_version",
    "discovery_rights_assessment",
    "discovery_triage",
    "discovery_evidence_association",
    "discovery_evidence_content",
  ];
  for (const kind of discoveryKinds) {
    assertEquals(
      RECORD_KINDS.includes(
        /** @type {import("../src/persistence/contracts.js").RecordKind} */ (kind),
      ),
      true,
    );
  }
});

Deno.test("discovery records append atomically and remain isolated by owner", async () => {
  const persistence = new MemoryPersistence();
  const kinds = /** @type {const} */ ([
    "discovery_source",
    "discovery_run",
    "discovery_item_version",
    "discovery_rights_assessment",
    "discovery_triage",
    "discovery_evidence_association",
    "discovery_evidence_content",
  ]);
  const records = kinds.map((kind, index) => ({
    id: `discovery-${index}`,
    ownerId: index === kinds.length - 1 ? "owner-b" : "owner-a",
    kind,
    payloadJson: JSON.stringify({ sequence: index + 1 }),
    recordedAt: "2026-07-21T00:00:00.000Z",
  }));

  const appended = await persistence.appendBatch(records);
  assertEquals(appended.ok, true);
  if (appended.ok) assertEquals(appended.value.length, kinds.length);

  for (const [index, kind] of kinds.entries()) {
    const ownerId = index === kinds.length - 1 ? "owner-b" : "owner-a";
    const listed = await persistence.list(ownerId, kind);
    assertEquals(listed.ok, true);
    if (listed.ok) assertEquals(listed.value.length, 1);
    const otherOwner = await persistence.list(
      ownerId === "owner-a" ? "owner-b" : "owner-a",
      kind,
    );
    if (otherOwner.ok) assertEquals(otherOwner.value.length, 0);
  }
});

Deno.test("batch duplicate leaves every new memory record uncommitted", async () => {
  const persistence = new MemoryPersistence();
  await persistence.append(event);
  const batch = await persistence.appendBatch([
    {
      ...event,
      id: "new-discovery-source",
      kind: "discovery_source",
    },
    { ...event },
  ]);
  assertEquals(batch.ok, false);
  if (!batch.ok) {
    assertEquals(batch.error.kind, "PersistenceDuplicate");
    if (batch.error.kind === "PersistenceDuplicate") {
      assertEquals(batch.error.recordId, event.id);
    }
  }
  const sources = await persistence.list("owner-a", "discovery_source");
  if (sources.ok) assertEquals(sources.value.length, 0);
});

Deno.test("batch rejects duplicate identifiers within the proposed write", async () => {
  const persistence = new MemoryPersistence();
  const duplicate = await persistence.appendBatch([
    { ...event, id: "same-id", kind: "discovery_source" },
    { ...event, id: "same-id", kind: "discovery_run" },
  ]);
  assertEquals(duplicate.ok, false);
  if (!duplicate.ok) assertEquals(duplicate.error.kind, "PersistenceDuplicate");
  const sources = await persistence.list("owner-a", "discovery_source");
  if (sources.ok) assertEquals(sources.value.length, 0);
});

Deno.test("persistence returns the exact invalid-record-kind failure", async () => {
  const persistence = new MemoryPersistence();
  const invalid =
    /** @type {import("../src/persistence/contracts.js").PersistenceEnvelope} */ (
      /** @type {unknown} */ ({ ...event, id: "invalid-kind", kind: "other" })
    );
  const appended = await persistence.append(invalid);
  assertEquals(appended.ok, false);
  if (!appended.ok) {
    assertEquals(appended.error.kind, "PersistenceRecordKindInvalid");
    if (appended.error.kind === "PersistenceRecordKindInvalid") {
      assertEquals(appended.error.recordId, "invalid-kind");
      assertEquals(appended.error.recordKind, "other");
    }
  }
});

Deno.test("persistence rejects malformed JSON payloads", async () => {
  const persistence = new MemoryPersistence();
  const invalid = await persistence.append({
    ...event,
    id: "invalid",
    payloadJson: "{",
  });
  assertEquals(invalid.ok, false);
  if (!invalid.ok) {
    assertEquals(invalid.error.kind, "PersistencePayloadInvalid");
  }
});

Deno.test("owner erasure removes only that owner's records", async () => {
  const persistence = new MemoryPersistence();
  await persistence.append(event);
  await persistence.append({ ...event, id: "event-2", ownerId: "owner-b" });
  const erased = await persistence.eraseOwner("owner-a");
  assertEquals(erased.ok, true);
  if (erased.ok) assertEquals(erased.value, 1);
  const ownerB = await persistence.list("owner-b", "preference_event");
  if (ownerB.ok) assertEquals(ownerB.value.length, 1);
});
