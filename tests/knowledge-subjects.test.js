// @ts-check
import { SUBJECTS, CLASSIFICATION_SCHEMA, parseClassification } from "../src/features/knowledge-subjects/public.js";
import { subjectPresentation } from "../src/features/knowledge-subjects/presentation.js";
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
