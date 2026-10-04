// @ts-check

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createJevAnswerGrader, JEV_OPENROUTER_ENDPOINT, JEV_OPENROUTER_MODEL } from "../worker/jev-answer-grader.js";

const cases = Object.freeze([
  { id: "canonical", label: "correct-canonical", prompt: "Name the pitches of a C major triad in root position.", response: "C, E, G.", canonicalAnswers: ["C, E, G"] },
  { id: "paraphrase", label: "correct-paraphrase", prompt: "Name the pitches of a C major triad in root position.", response: "The root C, its major third E, and perfect fifth G.", canonicalAnswers: ["C, E, G"] },
  { id: "wrong", label: "wrong", prompt: "Name the pitches of a C major triad in root position.", response: "C, D, G.", canonicalAnswers: ["C, E, G"] },
  { id: "partial", label: "partial", prompt: "Name the pitches of a C major triad in root position.", response: "C and E.", canonicalAnswers: ["C, E, G"] },
  { id: "contradiction", label: "contradiction", prompt: "Name the pitches of a C major triad in root position.", response: "C, E, G; the middle pitch is not a third above C.", canonicalAnswers: ["C, E, G"] },
  { id: "extra-claim", label: "extra-erroneous-claim", prompt: "Name the pitches of a C major triad in root position.", response: "C, E, G, and D is also part of the triad.", canonicalAnswers: ["C, E, G"] },
  { id: "multi-1", label: "multi-blank-correct", prompt: "Fill the three blanks for a C major triad in root position: __, __, __.", response: "C, E, G.", canonicalAnswers: ["C", "E", "G"] },
  { id: "multi-2", label: "multi-blank-partial", prompt: "Fill the three blanks for a C major triad in root position: __, __, __.", response: "C, E.", canonicalAnswers: ["C", "E", "G"] },
  { id: "multi-3", label: "multi-blank-wrong", prompt: "Fill the three blanks for a C major triad in root position: __, __, __.", response: "C, D, G.", canonicalAnswers: ["C", "E", "G"] },
]);
/** @typedef {{ readonly id: string, readonly label: string, readonly requestGroup: string, readonly accepted?: boolean, readonly probability?: number, readonly model?: string, readonly decision?: "error", readonly failureKind?: string }} Outcome */

const batches = Object.freeze([
  { name: "correct", ids: ["canonical", "paraphrase"] },
  { name: "negative", ids: ["wrong", "partial", "contradiction", "extra-claim"] },
  { name: "multi-blank", ids: ["multi-1", "multi-2", "multi-3"] },
]);
const outputPath = resolve(Deno.args[0] ?? "artifacts/jev-live-validation-2026-10-04.json");
const timeoutMs = 10_000;

/** @param {string} text */
function parseEnv(text) {
  const line = text.split(/\r?\n/u).find((entry) => /^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=/u.test(entry));
  if (line === undefined) return null;
  const raw = line.slice(line.indexOf("=") + 1).trim();
  const value = raw.replace(/^(['"])(.*)\1$/u, "$2");
  return value === "" ? null : value;
}

const envText = await readFile(".env", "utf8");
const apiKey = parseEnv(envText);
if (apiKey === null) throw new Error("OPENROUTER_API_KEY is missing from the normal local .env configuration.");

const startedAt = new Date().toISOString();
/** @type {Outcome[]} */
const outcomes = [];
const grader = createJevAnswerGrader({
  apiKey,
  endpoint: JEV_OPENROUTER_ENDPOINT,
  model: JEV_OPENROUTER_MODEL,
  fetch,
  timeoutMs,
  logger: () => {},
});

for (const batch of batches) {
  const selected = batch.ids.map((id) => {
    const testCase = cases.find((item) => item.id === id);
    if (testCase === undefined) throw new Error("Validation batch references an unknown case.");
    return testCase;
  });
  const prompt = selected[0].prompt;
  if (selected.some((item) => item.prompt !== prompt)) throw new Error("Each bounded batch must use one shared synthetic prompt.");
  const result = await grader.grade({ prompt, answers: selected.map(({ id, response, canonicalAnswers }) => ({ id, response, canonicalAnswers })) });
  if (!result.ok) {
    outcomes.push(...selected.map((testCase) => ({ id: testCase.id, label: testCase.label, requestGroup: batch.name, decision: /** @type {const} */ ("error"), failureKind: result.error.kind })));
    continue;
  }
  outcomes.push(...selected.map((testCase, index) => ({ id: testCase.id, label: testCase.label, requestGroup: batch.name, model: result.value.model, probability: result.value.probabilities[index], accepted: result.value.accepted[index] })));
}

const completedAt = new Date().toISOString();
const expectedAccept = new Set(["correct-canonical", "correct-paraphrase", "multi-blank-correct"]);
const byClass = Object.fromEntries([...new Set(cases.map((item) => item.label))].map((label) => {
  const entries = outcomes.filter((item) => item.label === label);
  const expected = expectedAccept.has(label);
  return [label, {
    count: entries.length,
    pass: entries.filter((item) => item.accepted === expected).length,
    fail: entries.filter((item) => item.accepted !== undefined && item.accepted !== expected).length,
    error: entries.filter((item) => item.decision === "error").length,
    falseAcceptances: entries.filter((item) => item.accepted === true && !expected).length,
    falseNegatives: entries.filter((item) => item.accepted === false && expected).length,
  }];
}));

const artifact = {
  schemaVersion: 1,
  startedAt,
  completedAt,
  endpoint: JEV_OPENROUTER_ENDPOINT,
  requestedModel: JEV_OPENROUTER_MODEL,
  timeoutMs,
  requestCount: batches.length,
  caseCount: cases.length,
  acceptanceThreshold: 0.8,
  outcomes,
  byClass,
  totals: {
    pass: outcomes.filter((item) => item.accepted !== undefined && item.accepted === expectedAccept.has(item.label)).length,
    fail: outcomes.filter((item) => item.accepted !== undefined && item.accepted !== expectedAccept.has(item.label)).length,
    error: outcomes.filter((item) => item.decision === "error").length,
    falseAcceptances: outcomes.filter((item) => item.accepted === true && !expectedAccept.has(item.label)).length,
    falseNegatives: outcomes.filter((item) => item.accepted === false && expectedAccept.has(item.label)).length,
  },
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ artifact: outputPath, requestCount: batches.length, caseCount: cases.length, totals: artifact.totals, byClass }));

if (artifact.totals.error > 0 || artifact.totals.falseAcceptances > 0 || artifact.totals.fail > 0) Deno.exit(1);
