CREATE TABLE source_notification_deliveries (
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  kind TEXT NOT NULL CHECK (kind IN ('source-ready', 'source-attention')),
  device_id TEXT NOT NULL CHECK (length(device_id) = 36),
  status TEXT NOT NULL CHECK (status IN ('claimed', 'sent', 'delivery-failed', 'disabled-expired')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, run_id, revision, kind, device_id)
) STRICT;

-- Preserve legacy attempts and their unique ordinal contract. New generations
-- get their own audit rows; existing erase/purge operations cascade from parent.
CREATE TABLE knowledge_workflow_quiz_retry_attempts (
  owner_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  knowledge_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  draft_id TEXT,
  score INTEGER CHECK (score IS NULL OR (score BETWEEN 1 AND 10)),
  feedback TEXT,
  failure_kind TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, attempt_id),
  FOREIGN KEY (owner_id, run_id, knowledge_id, attempt_number)
    REFERENCES knowledge_workflow_quiz_attempts(owner_id, run_id, knowledge_id, attempt_number)
    ON DELETE CASCADE
) STRICT;

CREATE INDEX knowledge_workflow_quiz_retry_attempts_parent
  ON knowledge_workflow_quiz_retry_attempts(owner_id, run_id, knowledge_id, attempt_number);
