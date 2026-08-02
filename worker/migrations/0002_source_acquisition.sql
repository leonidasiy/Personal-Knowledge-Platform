PRAGMA foreign_keys = ON;

ALTER TABLE source_ingestion_jobs ADD COLUMN lease_token TEXT;
ALTER TABLE source_ingestion_jobs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE source_ingestion_jobs ADD COLUMN plan_json TEXT CHECK (plan_json IS NULL OR json_valid(plan_json));
ALTER TABLE source_ingestion_jobs ADD COLUMN stop_reason TEXT;
ALTER TABLE source_ingestion_jobs ADD COLUMN pages_processed INTEGER NOT NULL DEFAULT 0 CHECK (pages_processed >= 0);
ALTER TABLE source_ingestion_jobs ADD COLUMN decoded_bytes INTEGER NOT NULL DEFAULT 0 CHECK (decoded_bytes >= 0);

ALTER TABLE source_item_versions ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 1 CHECK (source_revision >= 1);
ALTER TABLE source_rights_assessments ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 1 CHECK (source_revision >= 1);
ALTER TABLE source_rights_assessments ADD COLUMN item_version_id TEXT;
ALTER TABLE source_crawl_assessments ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 1 CHECK (source_revision >= 1);
ALTER TABLE source_content_references ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 1 CHECK (source_revision >= 1);
ALTER TABLE source_content_references ADD COLUMN item_version_id TEXT;
ALTER TABLE source_content_references ADD COLUMN state TEXT NOT NULL DEFAULT 'processing-ready' CHECK (state IN ('processing-ready', 'revoked'));

CREATE INDEX source_ingestion_jobs_owner_source_revision
  ON source_ingestion_jobs(owner_id, source_id, source_revision, state);
CREATE INDEX source_rights_owner_source_item
  ON source_rights_assessments(owner_id, source_id, item_id, item_version_id, assessed_at DESC);
CREATE UNIQUE INDEX source_content_owner_item_digest
  ON source_content_references(owner_id, source_id, item_id, item_version_id, content_digest);

CREATE TABLE source_manual_material_commands (
  owner_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL,
  content_reference_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, idempotency_key),
  FOREIGN KEY (owner_id, content_reference_id)
    REFERENCES source_content_references(owner_id, content_reference_id)
) STRICT;

CREATE TRIGGER source_item_versions_active_guard
BEFORE INSERT ON source_item_versions BEGIN
  SELECT RAISE(ABORT, 'inactive-or-stale-source') WHERE NOT EXISTS (
    SELECT 1 FROM library_sources
    WHERE owner_id = new.owner_id AND source_id = new.source_id
      AND state = 'active' AND revision = new.source_revision
  );
END;

CREATE TRIGGER source_rights_active_guard
BEFORE INSERT ON source_rights_assessments BEGIN
  SELECT RAISE(ABORT, 'inactive-or-stale-source') WHERE NOT EXISTS (
    SELECT 1 FROM library_sources
    WHERE owner_id = new.owner_id AND source_id = new.source_id
      AND state = 'active' AND revision = new.source_revision
  );
END;

CREATE TRIGGER source_crawl_active_guard
BEFORE INSERT ON source_crawl_assessments BEGIN
  SELECT RAISE(ABORT, 'inactive-or-stale-source') WHERE NOT EXISTS (
    SELECT 1 FROM library_sources
    WHERE owner_id = new.owner_id AND source_id = new.source_id
      AND state = 'active' AND revision = new.source_revision
  );
END;

CREATE TRIGGER source_content_active_guard
BEFORE INSERT ON source_content_references BEGIN
  SELECT RAISE(ABORT, 'inactive-or-stale-source') WHERE NOT EXISTS (
    SELECT 1 FROM library_sources
    WHERE owner_id = new.owner_id AND source_id = new.source_id
      AND state = 'active' AND revision = new.source_revision
  );
END;
