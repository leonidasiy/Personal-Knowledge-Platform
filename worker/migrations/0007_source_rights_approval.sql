PRAGMA foreign_keys = ON;

CREATE TABLE source_rights_approval_audits (
  owner_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  registry_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, approval_id),
  UNIQUE (owner_id, idempotency_key),
  FOREIGN KEY (owner_id, source_id)
    REFERENCES library_sources(owner_id, source_id)
) STRICT;

CREATE INDEX source_rights_approval_audits_owner_source
  ON source_rights_approval_audits(owner_id, source_id, source_revision, occurred_at DESC);
