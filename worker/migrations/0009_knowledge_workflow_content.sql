PRAGMA foreign_keys = ON;

CREATE TABLE knowledge_workflow_rights_decisions (
  owner_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('allowed', 'awaiting-review', 'denied')),
  decision_json TEXT NOT NULL CHECK (json_valid(decision_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, decision_id),
  FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id)
) STRICT;

CREATE TABLE extraction_scratchpads (
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  scratchpad_json TEXT NOT NULL CHECK (json_valid(scratchpad_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, run_id),
  FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id)
) STRICT;

CREATE TABLE extraction_knowledge_points (
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  knowledge_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  normalized_hash TEXT NOT NULL,
  point_json TEXT NOT NULL CHECK (json_valid(point_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, knowledge_id),
  UNIQUE (owner_id, run_id, normalized_hash),
  FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id)
) STRICT;

CREATE TABLE knowledge_workflow_quiz_attempts (
  owner_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  knowledge_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1 AND attempt_number <= 3),
  draft_id TEXT,
  score INTEGER CHECK (score IS NULL OR (score >= 1 AND score <= 10)),
  feedback TEXT,
  failure_kind TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, attempt_id),
  UNIQUE (owner_id, run_id, knowledge_id, attempt_number),
  FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id)
) STRICT;

CREATE TABLE knowledge_workflow_quizzes (
  owner_id TEXT NOT NULL,
  quiz_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  knowledge_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  draft_fingerprint TEXT NOT NULL,
  draft_json TEXT NOT NULL CHECK (json_valid(draft_json)),
  score INTEGER NOT NULL CHECK (score >= 8 AND score <= 10),
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1 AND attempt_number <= 3),
  status TEXT NOT NULL CHECK (status IN ('published', 'pending-review')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, quiz_id),
  UNIQUE (owner_id, run_id, knowledge_id),
  UNIQUE (owner_id, source_id, source_revision, draft_fingerprint),
  FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id)
) STRICT;

CREATE TABLE knowledge_workflow_restrictions (
  owner_id TEXT NOT NULL,
  restriction_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  knowledge_id TEXT NOT NULL,
  restricted_until TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, restriction_id),
  UNIQUE (owner_id, run_id, knowledge_id),
  FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id)
) STRICT;

CREATE TABLE knowledge_workflow_purge_tombstones (
  owner_id TEXT NOT NULL,
  tombstone_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  knowledge_id TEXT NOT NULL,
  purged_before TEXT NOT NULL,
  reason TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, tombstone_id),
  FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id)
) STRICT;

CREATE INDEX extraction_knowledge_points_owner_run
  ON extraction_knowledge_points(owner_id, run_id, created_at, knowledge_id);
CREATE INDEX knowledge_workflow_quiz_attempts_owner_run
  ON knowledge_workflow_quiz_attempts(owner_id, run_id, knowledge_id, attempt_number);

CREATE TABLE knowledge_workflow_media_assets (
  owner_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  knowledge_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  origin TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'screenshot')),
  media_type TEXT NOT NULL,
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  digest TEXT NOT NULL,
  private_original_key TEXT NOT NULL,
  attribution TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (owner_id, asset_id),
  FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id)
) STRICT;

CREATE TABLE knowledge_workflow_media_derivatives (
  owner_id TEXT NOT NULL,
  derivative_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  variant TEXT NOT NULL CHECK (variant IN ('feed', 'thumbnail')),
  media_type TEXT NOT NULL,
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  private_object_key TEXT NOT NULL,
  delivery_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, derivative_id),
  UNIQUE (owner_id, asset_id, variant),
  FOREIGN KEY (owner_id, asset_id) REFERENCES knowledge_workflow_media_assets(owner_id, asset_id)
) STRICT;

CREATE INDEX knowledge_workflow_media_owner_asset
  ON knowledge_workflow_media_derivatives(owner_id, asset_id, variant);

CREATE TABLE knowledge_workflow_run_tombstones (
  owner_id TEXT NOT NULL,
  tombstone_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  purged_before TEXT NOT NULL,
  reason TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, tombstone_id),
  FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id)
) STRICT;

CREATE INDEX knowledge_workflow_run_tombstones_owner_run
  ON knowledge_workflow_run_tombstones(owner_id, run_id, occurred_at DESC);
