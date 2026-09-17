PRAGMA foreign_keys = ON;

CREATE TABLE knowledge_workflow_materials (
  owner_id TEXT NOT NULL,
  material_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  idempotency_key TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  media_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  material_json TEXT NOT NULL CHECK (json_valid(material_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, material_id),
  UNIQUE (owner_id, idempotency_key),
  FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id)
) STRICT;

CREATE INDEX knowledge_workflow_materials_owner_run
  ON knowledge_workflow_materials(owner_id, run_id, created_at DESC, material_id);
