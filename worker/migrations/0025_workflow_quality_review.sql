PRAGMA foreign_keys = ON;

CREATE TABLE knowledge_workflow_stages (
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'completed', 'not-started')),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  provider_failures INTEGER NOT NULL DEFAULT 0 CHECK (provider_failures >= 0),
  failures_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(failures_json)),
  PRIMARY KEY (owner_id, run_id, stage_key),
  FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id),
  CHECK ((status = 'claimed' AND result_json IS NULL AND completed_at IS NULL) OR
         (status IN ('completed','not-started') AND result_json IS NOT NULL AND completed_at IS NOT NULL))
) STRICT;

CREATE TABLE knowledge_workflow_review_evidence (
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  knowledge_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  evidence_digest TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  PRIMARY KEY (owner_id, run_id, knowledge_id),
  FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id)
) STRICT;
