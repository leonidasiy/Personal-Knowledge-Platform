// @ts-check
import { assertEquals, assert, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createSourceClassifier, parseSourceClassification } from "../src/features/source-classification/public.js";

const valid = { mainSubject: "music", topic: "Cadential harmony" };

Deno.test("source classifier sends every consolidated point to one dedicated inference and parses exact two-field output", async () => {
  const points = [
    { id: "p1", summary: "A cadence resolves harmonic tension.", evidenceAnchors: [{ url: "https://example.test/a", selector: "#a" }], coverageGoalIds: ["harmony"], mediaCandidates: [], attribution: { sourceUrl: "https://example.test/a" }, extractionVersion: "v1", classification: { version: 1, primarySubject: "music", secondarySubjects: [], subcategory: "old" } },
    { id: "p2", summary: "Applied dominants tonicize a non-tonic chord.", evidenceAnchors: [{ url: "https://example.test/b", selector: "#b" }], coverageGoalIds: [], mediaCandidates: [], attribution: { sourceUrl: "https://example.test/b" }, extractionVersion: "v1" },
    { id: "p3", summary: "Image shows figured-bass resolution.", evidenceAnchors: [{ url: "https://example.test/c", selector: "#c" }], coverageGoalIds: [], mediaCandidates: [{ visualId: "image-1" }], attribution: { sourceUrl: "https://example.test/c" }, extractionVersion: "v1" },
  ];
  /** @type {import("../src/features/source-classification/public.js").SourceClassificationProviderCommand[]} */ const calls = [];
  const classifier = createSourceClassifier({
    provider: { generate: async (command) => { calls.push(command); return { ok: true, value: { output: valid } }; } },
    logger: () => {},
  });
  const result = await classifier.classify({ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 4, title: "Harmony", points });
  assert(result.ok);
  assertEquals(result.value, valid);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].input, { source: { title: "Harmony" }, points: points.map(({ classification: _legacy, ...point }) => point) });
  assertEquals(calls[0].responseSchema.schema.required, ["mainSubject", "topic"]);
  assert(calls[0].systemPrompt.includes("source-wide"));
  assertFalse(calls[0].systemPrompt.includes("old"));
});

Deno.test("source classification rejects extra fields, unknown subjects, malformed topics, and failed inference", async () => {
  for (const output of [
    { ...valid, secondarySubjects: [] },
    { mainSubject: "invented", topic: "Cadential harmony" },
    { mainSubject: "music", topic: "  " },
    { mainSubject: "music", topic: "<script>" },
  ]) {
    const result = parseSourceClassification(output);
    assertFalse(result.ok);
  }
  const classifier = createSourceClassifier({
    provider: { generate: async () => ({ ok: false, error: { kind: "ProviderUnavailable" } }) },
    logger: () => {},
  });
  const result = await classifier.classify({ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 4, title: "Harmony", points: [{ id: "p1", summary: "A cadence resolves.", attribution: { sourceUrl: "https://example.test/a" } }] });
  assertFalse(result.ok);
  if (!result.ok) assertEquals(result.error.kind, "SourceClassificationInferenceFailed");
});

Deno.test("source classification rejects an empty consolidated point set", async () => {
  const classifier = createSourceClassifier({ provider: { generate: async () => ({ ok: true, value: { output: valid } }) }, logger: () => {} });
  const result = await classifier.classify({ ownerId: "owner-a", sourceId: "source-a", sourceRevision: 4, title: "Harmony", points: [] });
  assertFalse(result.ok);
  if (!result.ok) assertEquals(result.error.kind, "SourceClassificationInputInvalid");
});

Deno.test("source classifier maps provider rejection and malformed provider envelope to named failures", async () => {
  const command = { ownerId: "owner-a", sourceId: "source-a", sourceRevision: 4, title: "Harmony", points: [{ id: "p1", summary: "A cadence resolves.", evidenceAnchors: [], coverageGoalIds: [], mediaCandidates: [], attribution: { sourceUrl: "https://example.test/a" }, extractionVersion: "v1" }] };
  const throwing = createSourceClassifier({ provider: { generate: async () => { throw new Error("secret provider detail"); } }, logger: () => {} });
  const rejected = await throwing.classify(command);
  assertFalse(rejected.ok);
  if (!rejected.ok) assertEquals(rejected.error.kind, "SourceClassificationInferenceFailed");
  const malformed = createSourceClassifier({ provider: { generate: async () => /** @type {never} */ ({ ok: true, value: { output: null } }) }, logger: () => {} });
  const invalid = await malformed.classify(command);
  assertFalse(invalid.ok);
  if (!invalid.ok) assertEquals(invalid.error.kind, "SourceClassificationOutputInvalid");
});

Deno.test("source decision model uses configured Flash and LOW rather than scraper HIGH", async () => {
  const {createSourceDecisionModel} = await import("../worker/knowledge-workflow-model.js");
  let requestBody = /** @type {Record<string,unknown>} */ ({});
  const model = createSourceDecisionModel({configuration:{model:{provider:'openrouter',name:'z-ai/glm-5.3-flash',reasoningEffort:'high'},limits:{maxTurns:3,maxToolCalls:8,timeoutMs:120000,maxOutputBytes:65536,compactionThresholdTokens:500000}},apiKey:'fixture',endpoint:'https://model.example.test',maximumInputCharacters:3000000,now:()=>0,logger:()=>{},fetch:async (_input,init)=>{requestBody=JSON.parse(String(init?.body));return Response.json({id:'fixture-response',choices:[{finish_reason:'stop',message:{content:JSON.stringify(valid)}}],usage:{prompt_tokens:10,completion_tokens:20}});}});
  const result = await model.generate({role:'source-assessor',systemPrompt:'Classify supplied points.',input:{points:['A cadence resolves.']},maxOutputTokens:256,reasoningEffort:'low'});
  assert(result.ok);
  assertEquals(requestBody.model,'z-ai/glm-5.3-flash');
  assertEquals(requestBody.max_tokens,256);
  assertEquals(requestBody.reasoning,{effort:'low'});
});
