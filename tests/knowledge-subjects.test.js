
const shell = Deno.readTextFileSync("index.html");
Object.defineProperty(globalThis, "document", { configurable: true, value: {
  getElementById: (/** @type {string} */ id) => {
    const content = shell.match(new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`))?.[1];
    return content === undefined ? null : { textContent: content };
  },
} });
// @ts-check
import { SUBJECTS, CLASSIFICATION_SCHEMA, parseClassification } from "../src/features/knowledge-subjects/public.js";
import { subjectPresentation } from "../src/features/knowledge-subjects/presentation.js";
import { createLearnerController } from "../src/features/learning-generation/learner.js";
/** @param {unknown} value @param {string} message */
function assert(value, message) { if (!value) throw new Error(message); }
const music = { version: 1, primarySubject: "music", secondarySubjects: ["mathematics"], subcategory: "Rhythm and proportion" };
Deno.test("subject taxonomy is exactly the approved closed 22 with deterministic presentation", () => {
  assert(SUBJECTS.length === 22 && new Set(SUBJECTS.map(s => s.id)).size === 22, "closed registry");
  assert(CLASSIFICATION_SCHEMA.properties.primarySubject.anyOf[0].enum?.length === 22, "provider matches registry");
  const cues = new Set();
  const motifs = new Set();
  for (const subject of SUBJECTS) {
    const presentation = subjectPresentation(subject.id);
    if (presentation === null) throw new Error("Missing subject presentation");
    cues.add(presentation.cue.frequencyHz); motifs.add(presentation.path);
    assert(presentation.cue.durationSeconds <= .12 && presentation.cue.peakGain <= .02, "short low-gain cues");
    assert(parseClassification({ ...music, primarySubject: subject.id, secondarySubjects: [] }).ok, "every subject parses");
  }
  assert(cues.size === 22 && motifs.size === 22, "distinct cues and motifs");
  assert(subjectPresentation(null) === null && subjectPresentation("invented") === null, "neutral unavailable metadata");
});
Deno.test("classification admits grounded free subcategories and explicit uncertainty only", () => {
  assert(parseClassification(music).ok, "valid interdisciplinary point");
  assert(parseClassification({ ...music, subcategory: "节奏与比例" }).ok, "multilingual category");
  assert(parseClassification({ version: 1, primarySubject: null, secondarySubjects: [], subcategory: null }).ok, "explicit unclassified");
  for (const value of [undefined, null, {}, { ...music, version: 2 }, { ...music, primarySubject: "invented" }, { ...music, secondarySubjects: ["music"] }, { ...music, secondarySubjects: ["physics", "physics"] }, { ...music, secondarySubjects: ["physics", "arts", "biology"] }, { ...music, primarySubject: null }, { ...music, subcategory: "<script>alert(1)</script>" }, { ...music, subcategory: "a".repeat(81) }, { ...music, subcategory: " leading" }, { ...music, css: "url(https://example.test)" }]) assert(!parseClassification(value).ok, "reject malformed classification");
});

Deno.test("knowledge card identity follows its saved source subject and keeps evidence and controls", async () => {
  for (const subject of [...SUBJECTS, { id: null, label: "Unclassified" }]) {
    const controller = createLearnerController({
      fetch: async () => new Response(JSON.stringify({ result: {
        batch: { batchId: "synthetic-subject", learningDay: "2026-10-05", status: "open", itemIds: ["synthetic-card"], revision: 1, createdAt: "2026-10-05T00:00:00.000Z", completedAt: null },
        items: [{ knowledgeId: "synthetic-card", sourceId: "synthetic-source", sourceRevision: 1, sourceClassification: subject.id === null ? null : { mainSubject: subject.id, topic: "Synthetic topic" }, sourceClassificationRevision: subject.id === null ? 0 : 1, questionId: "synthetic-question", title: "Synthetic source", summary: "Read the knowledge first.", sourceUrl: "https://example.test/source", evidenceAnchorIds: ["synthetic-anchor"], media: null, questionLocked: true }],
      } }), { headers: { "content-type": "application/json" } }),
      baseUrl: "https://example.test/", timeoutMs: 1000, escapeHtml: value => value, now: () => "2026-10-05T00:00:00.000Z", createId: () => "synthetic", onChange: () => {},
    });
    assert((await controller.loadFeed()).ok, "Saved subject fixture passes the gateway boundary");
    const feed = controller.renderFeed();
    const card = feed.slice(feed.indexOf('<article class="learning-card"'), feed.indexOf("</article>") + 10);
    assert(card.includes(subject.label), "Subject is named in text, independently of color");
    assert(card.indexOf("card-knowledge") < card.indexOf("card-source") && card.indexOf("card-source") < card.indexOf("card-subject"), "Reading order is preserved");
    assert(card.includes("Source evidence") && card.includes("synthetic-anchor") && card.includes("Edit source classification"), "Details and editor remain accessible");
    assert(card.includes('data-preference="more"') && card.includes('data-preference="less"') && card.includes('data-action="remove-learner-knowledge"'), "All preference controls remain available");
    assert(!card.includes('style="'), "Palette and outline are authored in CSS, independent of taxonomy position");
    if (subject.id === null) assert(!card.includes("data-subject=") && !card.includes("subject-mark"), "Unclassified content has the explicit neutral presentation");
    else {
      assert(card.includes(`data-subject="${subject.id}"`), "The authoritative source subject selects the identity");
      assert(card.includes('aria-hidden="true"') && card.includes(subjectPresentation(subject.id)?.path ?? "missing"), "Each subject retains its own decorative symbol");
    }
  }
});
