PRAGMA foreign_keys = ON;

CREATE TABLE learning_generation_jobs (
  owner_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  item_id TEXT NOT NULL,
  item_version_id TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('public-text', 'manual-transcript')),
  rights_evidence_id TEXT NOT NULL,
  attribution_json TEXT CHECK (attribution_json IS NULL OR json_valid(attribution_json)),
  policy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'revoked')),
  local_only INTEGER NOT NULL CHECK (local_only IN (0, 1)),
  provider_request_id TEXT,
  failure_kind TEXT,
  idempotency_key TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, generation_id),
  UNIQUE (owner_id, idempotency_key),
  FOREIGN KEY (owner_id, source_id) REFERENCES library_sources(owner_id, source_id)
) STRICT;

CREATE TABLE learning_generation_units (
  owner_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  item_id TEXT NOT NULL,
  item_version_id TEXT NOT NULL,
  unit_json TEXT NOT NULL CHECK (json_valid(unit_json)),
  PRIMARY KEY (owner_id, generation_id, unit_id),
  FOREIGN KEY (owner_id, generation_id) REFERENCES learning_generation_jobs(owner_id, generation_id)
) STRICT;

CREATE TABLE learning_generation_tasks (
  owner_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  item_id TEXT NOT NULL,
  item_version_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending-review', 'published', 'rejected', 'hidden')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  task_json TEXT NOT NULL CHECK (json_valid(task_json)),
  PRIMARY KEY (owner_id, task_id),
  FOREIGN KEY (owner_id, generation_id) REFERENCES learning_generation_jobs(owner_id, generation_id)
) STRICT;

CREATE TABLE learning_generation_review_audits (
  owner_id TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 1),
  resulting_revision INTEGER NOT NULL CHECK (resulting_revision >= 1),
  idempotency_key TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (owner_id, idempotency_key),
  PRIMARY KEY (owner_id, audit_id)
) STRICT;

CREATE TABLE learning_generation_revocations (
  owner_id TEXT NOT NULL,
  revocation_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  idempotency_key TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL,
  reason TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  revoked_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, revocation_id),
  UNIQUE (owner_id, idempotency_key)
) STRICT;

CREATE TABLE learning_generation_tombstones (
  owner_id TEXT NOT NULL,
  tombstone_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  item_id TEXT NOT NULL,
  item_version_id TEXT NOT NULL,
  descendant_kind TEXT NOT NULL CHECK (descendant_kind IN ('generation', 'unit', 'task')),
  descendant_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, tombstone_id)
) STRICT;

CREATE TABLE learning_generation_facts (
  owner_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  fact_kind TEXT NOT NULL CHECK (fact_kind IN ('review-decision', 'study-response', 'schedule')),
  occurred_at TEXT NOT NULL,
  correct INTEGER,
  schedule_step INTEGER CHECK (schedule_step IS NULL OR (schedule_step >= 0 AND schedule_step <= 4)),
  PRIMARY KEY (owner_id, fact_id)
) STRICT;

CREATE TABLE learning_generation_budget_months (
  owner_id TEXT NOT NULL,
  budget_month TEXT NOT NULL CHECK (budget_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  committed_usd REAL NOT NULL CHECK (committed_usd >= 0),
  reserved_usd REAL NOT NULL CHECK (reserved_usd >= 0),
  PRIMARY KEY (owner_id, budget_month)
) STRICT;

CREATE TABLE learning_generation_budget_reservations (
  owner_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  budget_month TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  amount_usd REAL NOT NULL CHECK (amount_usd >= 0),
  actual_usd REAL CHECK (actual_usd IS NULL OR actual_usd >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'completed', 'failed', 'uncertain')),
  fingerprint TEXT NOT NULL,
  PRIMARY KEY (owner_id, reservation_id),
  UNIQUE (owner_id, budget_month, idempotency_key)
) STRICT;

CREATE INDEX learning_generation_jobs_owner_created
  ON learning_generation_jobs(owner_id, created_at DESC, generation_id DESC);
CREATE INDEX learning_generation_tasks_owner_status
  ON learning_generation_tasks(owner_id, status, generation_id);
CREATE INDEX learning_generation_tombstones_owner_source
  ON learning_generation_tombstones(owner_id, source_id, source_revision);
CREATE INDEX learning_generation_facts_owner_task_time
  ON learning_generation_facts(owner_id, task_id, occurred_at);
