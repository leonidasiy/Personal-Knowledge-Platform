CREATE TABLE source_classification_backfill_checkpoints (
  owner_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('completed', 'needs-review', 'manual-preserved')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, source_id, source_revision),
  FOREIGN KEY (owner_id, source_id) REFERENCES library_sources(owner_id, source_id) ON DELETE CASCADE
) STRICT;
