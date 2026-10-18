import { WorkflowEntrypoint } from "cloudflare:workers";
import { executeKnowledgeWorkflow } from "./knowledge-workflow-executor.mjs";
import { KNOWLEDGE_WORKFLOW_CONFIG_SOURCES } from "./knowledge-workflow-config-sources.js";

export class KnowledgeExtractionWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return executeKnowledgeWorkflow(this.env, event, step, KNOWLEDGE_WORKFLOW_CONFIG_SOURCES);
  }
}
