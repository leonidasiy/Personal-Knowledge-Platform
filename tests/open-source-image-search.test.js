import { createOpenSourceImageSearch } from "../worker/open-source-image-search.js";

/** @param {boolean} condition @param {string} message */
function assert(condition, message) { if (!condition) throw new Error(message); }

Deno.test("knowledge browser and image-search composition adapters return the typed logger Result", async () => {
  const source = await Deno.readTextFile(new URL("../worker/knowledge-workflow-entry.mjs", import.meta.url));
  assert(source.includes('logger: (entry) => logger({ event: entry.event, ownerId, stage: "browser"'), "Browser logger adapter must return the typed logger result.");
  assert(source.includes('logger: (entry) => logger({ event: entry.event, ownerId, stage: "media"'), "Image-search logger adapter must return the typed logger result.");
  assert(!source.includes('logger: (entry) => { logger({ event: entry.event, ownerId, stage: "browser"'), "Browser logger adapter must not discard the typed logger result.");
  assert(!source.includes('logger: (entry) => { logger({ event: entry.event, ownerId, stage: "media"'), "Image-search logger adapter must not discard the typed logger result.");
});

Deno.test("open-source image search returns only relevant reusable image candidates", async () => {
  const search = createOpenSourceImageSearch({
    fetch: async () => Response.json({ results: [{ title: "Music notation and piano", creator: "Open creator", license: "cc-by", license_url: "https://creativecommons.org/licenses/by/4.0/", foreign_landing_url: "https://commons.wikimedia.org/example", url: "https://images.example/music.jpg", mime_type: "image/jpeg" }, { title: "Unrelated landscape", creator: "Other", license: "cc0", url: "https://images.example/landscape.jpg" }] }),
    logger: () => {},
  });
  const result = await search.search({ query: "music notation" });
  assert(result.ok, "Image search should return a projection.");
  if (!result.ok) return;
  assert(result.value.length === 1, "Only the relevant reusable image should be retained.");
  assert(result.value[0].rights.transformation === "allowed", "Only transformable media may enter the learning feed.");
});

Deno.test("open-source image search rejects non-reusable and rate-limited results explicitly", async () => {
  const blocked = createOpenSourceImageSearch({ fetch: async () => new Response(null, { status: 429 }), logger: () => {} });
  const rateLimited = await blocked.search({ query: "music" });
  assert(!rateLimited.ok && rateLimited.error.kind === "ImageSearchRateLimited", "Rate limits must remain visible to the workflow.");
  const rejected = createOpenSourceImageSearch({ fetch: async () => Response.json({ results: [{ title: "Music video", license: "cc-by-nc-nd", url: "https://images.example/music.jpg" }] }), logger: () => {} });
  const result = await rejected.search({ query: "music video" });
  assert(result.ok && result.value.length === 0, "Non-reusable media must be discarded without bypassing its licence.");
});

Deno.test("direct image-search use logs only bounded outcomes, never query or summary text", async () => {
  /** @type {Record<string, unknown>[]} */ const logs = [];
  const search = createOpenSourceImageSearch({
    fetch: async () => Response.json({ results: [{ title: "query-derived private summary", creator: "Creator", license: "cc0", url: "https://images.example/music.jpg" }] }),
    logger: (entry) => logs.push(entry),
  });
  const result = await search.search({ query: "query-derived private summary" });
  assert(result.ok, "Image search should remain successful.");
  const serialized = JSON.stringify(logs);
  assert(!serialized.includes("query-derived private summary"), "Raw query-derived text must not enter logs.");
  assert(serialized.includes("resultCount"), "Bounded result count should remain observable.");
});
