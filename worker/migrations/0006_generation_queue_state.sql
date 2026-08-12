PRAGMA foreign_keys = ON;

ALTER TABLE source_ingestion_jobs ADD COLUMN generation_state TEXT NOT NULL DEFAULT 'not-requested' CHECK (generation_state IN ('not-requested', 'queued', 'completed', 'failed'));
ALTER TABLE source_ingestion_jobs ADD COLUMN generation_failure TEXT;

CREATE INDEX source_ingestion_jobs_owner_generation_state
  ON source_ingestion_jobs(owner_id, generation_state, updated_at, job_id);
