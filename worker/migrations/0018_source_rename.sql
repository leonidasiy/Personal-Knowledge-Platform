-- Keep title-only changes in the existing source audit/idempotency stream.
CREATE TABLE library_source_events_renamed (
  owner_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('approved', 'revised', 'disabled', 'restored', 'renamed')),
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  idempotency_key TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  old_title TEXT,
  new_title TEXT,
  run_id TEXT,
  CHECK (event_kind != 'renamed' OR (old_title IS NOT NULL AND new_title IS NOT NULL AND length(trim(new_title)) BETWEEN 1 AND 300 AND run_id IS NOT NULL)),
  PRIMARY KEY (owner_id, event_id),
  UNIQUE (owner_id, idempotency_key),
  FOREIGN KEY (owner_id, source_id) REFERENCES library_sources(owner_id, source_id)
) STRICT;
INSERT INTO library_source_events_renamed (owner_id,event_id,source_id,event_kind,source_revision,idempotency_key,command_fingerprint,occurred_at)
SELECT owner_id,event_id,source_id,event_kind,source_revision,idempotency_key,command_fingerprint,occurred_at FROM library_source_events;
DROP TABLE library_source_events;
ALTER TABLE library_source_events_renamed RENAME TO library_source_events;
CREATE INDEX library_source_events_owner_source_order
  ON library_source_events(owner_id, source_id, occurred_at, event_id);

-- One statement owns the compare-and-set and its audit/idempotency record.
-- RAISE aborts the complete statement (and D1 batch), including trigger writes.
CREATE TRIGGER library_source_rename_guard
BEFORE INSERT ON library_source_events WHEN NEW.event_kind = 'renamed' BEGIN
  SELECT RAISE(ABORT, 'source-rename-conflict') WHERE NOT EXISTS (
    SELECT 1 FROM library_sources s JOIN knowledge_workflow_runs r
      ON r.owner_id = s.owner_id AND r.source_id = s.source_id AND r.source_revision = s.revision
    WHERE s.owner_id = NEW.owner_id AND s.source_id = NEW.source_id
      AND s.state = 'active' AND s.revision = NEW.source_revision AND s.title = NEW.old_title
      AND r.run_id = NEW.run_id AND r.state = 'awaiting-upload'
      AND r.canonical_source_identity = s.canonical_url
      AND r.run_id = (SELECT latest.run_id FROM knowledge_workflow_runs latest WHERE latest.owner_id = s.owner_id AND latest.source_id = s.source_id AND latest.source_revision = s.revision ORDER BY latest.updated_at DESC, latest.run_id DESC LIMIT 1)
  );
  UPDATE library_sources SET title = NEW.new_title, updated_at = NEW.occurred_at
    WHERE owner_id = NEW.owner_id AND source_id = NEW.source_id
      AND revision = NEW.source_revision AND title = NEW.old_title AND state = 'active';
  SELECT RAISE(ABORT, 'source-rename-conflict') WHERE changes() != 1;
END;
