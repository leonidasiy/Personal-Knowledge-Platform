// @ts-check

import { unitize } from "../src/features/learning-generation/unitization.js";

/** @template T @param {T} actual @param {T} expected */
function assertEquals(actual, expected) {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}.`);
  }
}

const policy = Object.freeze({
  version: "unitization-v1",
  maximumContentCharacters: 200,
  maximumWordsPerUnit: 5,
  maximumUnits: 10,
  maximumExcerptCharacters: 80,
});

function command(content = "A first sentence with facts. A second sentence follows.") {
  return {
    ownerId: "owner-a",
    sourceId: "source-a",
    sourceRevision: 2,
    itemId: "item-a",
    itemVersionId: "version-a",
    contentDigest: "sha256:content-a",
    sourceKind: "public-text",
    content,
    policy,
  };
}

Deno.test("unitization is deterministic and returns bounded source anchors", () => {
  const first = unitize(command());
  const second = unitize(command());
  assertEquals(first.ok, true);
  assertEquals(second.ok, true);
  if (!first.ok || !second.ok) return;
  assertEquals(JSON.stringify(first.value), JSON.stringify(second.value));
  assertEquals(first.value.units.length, 2);
  assertEquals(first.value.units[0].text, "A first sentence with facts.");
  assertEquals(first.value.units[1].text, "A second sentence follows.");
  for (const unit of first.value.units) {
    assertEquals(unit.text, command().content.slice(unit.startOffset, unit.endOffset));
    assertEquals(unit.sourceAnchorIds.length, 1);
    assertEquals(unit.wordCount <= policy.maximumWordsPerUnit, true);
    assertEquals(unit.text.length <= policy.maximumExcerptCharacters, true);
  }
});

Deno.test("unitization accepts exact boundaries and names every invalid boundary", () => {
  const exactContent = "one two three";
  const exact = unitize({
    ...command(exactContent),
    policy: { ...policy, maximumContentCharacters: exactContent.length, maximumWordsPerUnit: 3 },
  });
  assertEquals(exact.ok, true);

  const contentTooLong = unitize({
    ...command(exactContent),
    policy: { ...policy, maximumContentCharacters: exactContent.length - 1 },
  });
  assertEquals(contentTooLong.ok, false);
  if (!contentTooLong.ok) assertEquals(contentTooLong.error.kind, "LearningUnitizationLimitExceeded");

  const unitsTooMany = unitize({
    ...command("First. Second."),
    policy: { ...policy, maximumUnits: 1 },
  });
  assertEquals(unitsTooMany.ok, false);
  if (!unitsTooMany.ok) {
    assertEquals(unitsTooMany.error.kind, "LearningUnitizationLimitExceeded");
    if (unitsTooMany.error.kind === "LearningUnitizationLimitExceeded") {
      assertEquals(unitsTooMany.error.field, "units");
    }
  }

  const empty = unitize(command(" \n\t"));
  assertEquals(empty.ok, false);
  if (!empty.ok) assertEquals(empty.error.kind, "LearningContentEmpty");

  const malformed = unitize(command("broken \uD800 text"));
  assertEquals(malformed.ok, false);
  if (!malformed.ok) assertEquals(malformed.error.kind, "LearningContentEncodingInvalid");

  const invalidPolicy = unitize({
    ...command(),
    policy: { ...policy, maximumWordsPerUnit: 0 },
  });
  assertEquals(invalidPolicy.ok, false);
  if (!invalidPolicy.ok) assertEquals(invalidPolicy.error.kind, "LearningUnitizationPolicyInvalid");
});
