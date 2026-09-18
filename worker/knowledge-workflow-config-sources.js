// @ts-check

// Wrangler's Text module rule turns these reviewed YAML files into immutable
// source strings at bundle time. They are intentionally not parsed from a
// request, environment variable, or user-controlled storage.
// @ts-ignore Wrangler Text module import.
import rightsAssessor from "../agent-config/rights-assessor.yaml";
// @ts-ignore Wrangler Text module import.
import knowledgeScraper from "../agent-config/knowledge-scraper.yaml";
// @ts-ignore Wrangler Text module import.
import questionGenerator from "../agent-config/question-generator.yaml";
// @ts-ignore Wrangler Text module import.
import questionEvaluator from "../agent-config/question-evaluator.yaml";

/** @typedef {import("../src/features/knowledge-workflows/memory.js").AgentRole} AgentRole */

/** @type {Readonly<Record<AgentRole, string>>} */
export const KNOWLEDGE_WORKFLOW_CONFIG_SOURCES = Object.freeze({
  "rights-assessor": rightsAssessor,
  "knowledge-scraper": knowledgeScraper,
  "question-generator": questionGenerator,
  "question-evaluator": questionEvaluator,
});
