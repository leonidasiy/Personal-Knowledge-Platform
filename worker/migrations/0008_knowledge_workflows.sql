PRAGMA foreign_keys = ON;

CREATE TABLE knowledge_workflow_runs (
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  canonical_source_identity TEXT NOT NULL,
  content_signature TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  idempotency_key TEXT NOT NULL,
  config_digests_json TEXT NOT NULL CHECK (json_valid(config_digests_json)),
  extraction_started_at TEXT,
  extraction_deadline_at TEXT,
  decision_required TEXT,
  counts_json TEXT NOT NULL CHECK (json_valid(counts_json)),
  failure_kind TEXT,
  reused INTEGER NOT NULL CHECK (reused IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  run_json TEXT NOT NULL CHECK (json_valid(run_json)),
  PRIMARY KEY (owner_id, run_id),
  UNIQUE (owner_id, idempotency_key)
) STRICT;

CREATE TABLE knowledge_source_manifests (
  canonical_source_identity TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  content_signature TEXT NOT NULL,
  config_digests_json TEXT NOT NULL CHECK (json_valid(config_digests_json)),
  counts_json TEXT NOT NULL CHECK (json_valid(counts_json)),
  status TEXT NOT NULL CHECK (status = 'completed'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (canonical_source_identity, source_revision, content_signature)
) STRICT;

CREATE TABLE knowledge_workflow_controls (
  owner_id TEXT NOT NULL,
  control_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, control_id),
  UNIQUE (owner_id, idempotency_key),
  FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id)
) STRICT;

CREATE INDEX knowledge_workflow_runs_owner_state
  ON knowledge_workflow_runs(owner_id, state, updated_at DESC, run_id);
CREATE INDEX knowledge_workflow_controls_owner_run
  ON knowledge_workflow_controls(owner_id, run_id, occurred_at DESC);

CREATE TABLE agent_memory_namespaces (
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  role TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('durable', 'disabled')),
  human_approval_id TEXT,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, namespace_id),
  UNIQUE (owner_id, run_id, role),
  FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id)
) STRICT;

CREATE TABLE agent_memory_records (
  owner_id TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, namespace_id, record_id),
  FOREIGN KEY (owner_id, namespace_id) REFERENCES agent_memory_namespaces(owner_id, namespace_id)
) STRICT;

CREATE TABLE agent_shared_handoffs (
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  from_namespace_id TEXT NOT NULL,
  to_namespace_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, handoff_id),
  FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id)
) STRICT;

CREATE TABLE agent_event_ledger (
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  role TEXT NOT NULL,
  task_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, event_id),
  FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id)
) STRICT;

CREATE TABLE agent_compaction_records (
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, record_id),
  FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id)
) STRICT;
