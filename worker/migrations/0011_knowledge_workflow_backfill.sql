CREATE TABLE IF NOT EXISTS knowledge_workflow_backfill_markers (
  owner_id TEXT NOT NULL,
  backfill_key TEXT NOT NULL,
  source_count INTEGER NOT NULL CHECK (source_count >= 0),
  run_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, backfill_key)
);
