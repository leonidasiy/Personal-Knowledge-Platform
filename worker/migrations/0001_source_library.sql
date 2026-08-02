PRAGMA foreign_keys = ON;

CREATE TABLE interest_areas (
  owner_id TEXT NOT NULL,
  interest_area_id TEXT NOT NULL,
  label TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, interest_area_id)
) STRICT;

CREATE TABLE library_sources (
  owner_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  submitted_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  adapter_json TEXT NOT NULL CHECK (json_valid(adapter_json)),
  identity_evidence_json TEXT NOT NULL CHECK (json_valid(identity_evidence_json)),
  state TEXT NOT NULL CHECK (state IN ('active', 'disabled')),
  approved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  PRIMARY KEY (owner_id, source_id),
  UNIQUE (owner_id, canonical_url)
) STRICT;

CREATE TABLE library_source_events (
  owner_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('approved', 'revised', 'disabled', 'restored')),
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  idempotency_key TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, event_id),
  UNIQUE (owner_id, idempotency_key),
  FOREIGN KEY (owner_id, source_id) REFERENCES library_sources(owner_id, source_id)
) STRICT;

CREATE TABLE source_interest_areas (
  owner_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  interest_area_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, source_id, interest_area_id),
  FOREIGN KEY (owner_id, source_id) REFERENCES library_sources(owner_id, source_id),
  FOREIGN KEY (owner_id, interest_area_id) REFERENCES interest_areas(owner_id, interest_area_id)
) STRICT;

CREATE TABLE source_ingestion_jobs (
  owner_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  policy_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'partial', 'completed', 'failed', 'cancelled')),
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, job_id),
  UNIQUE (owner_id, idempotency_key),
  FOREIGN KEY (owner_id, source_id) REFERENCES library_sources(owner_id, source_id)
) STRICT;

CREATE TABLE source_item_versions (
  owner_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  observed_at TEXT NOT NULL,
  published_at TEXT,
  PRIMARY KEY (owner_id, source_id, item_id, version_id),
  FOREIGN KEY (owner_id, source_id) REFERENCES library_sources(owner_id, source_id)
) STRICT;

CREATE TABLE source_rights_assessments (
  owner_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  item_id TEXT,
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  assessed_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (owner_id, assessment_id),
  FOREIGN KEY (owner_id, source_id) REFERENCES library_sources(owner_id, source_id)
) STRICT;

CREATE TABLE source_crawl_assessments (
  owner_id TEXT NOT NULL,
  assessment_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  selected_depth INTEGER NOT NULL CHECK (selected_depth >= 0),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  outcome TEXT NOT NULL,
  assessed_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, assessment_id),
  FOREIGN KEY (owner_id, source_id) REFERENCES library_sources(owner_id, source_id)
) STRICT;

CREATE TABLE source_content_references (
  owner_id TEXT NOT NULL,
  content_reference_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  item_id TEXT,
  object_key TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  rights_assessment_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, content_reference_id),
  FOREIGN KEY (owner_id, source_id) REFERENCES library_sources(owner_id, source_id),
  FOREIGN KEY (owner_id, rights_assessment_id) REFERENCES source_rights_assessments(owner_id, assessment_id)
) STRICT;

CREATE TABLE source_suppressions (
  owner_id TEXT NOT NULL,
  suppression_id TEXT NOT NULL,
  canonical_identity TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, suppression_id),
  UNIQUE (owner_id, canonical_identity),
  UNIQUE (owner_id, idempotency_key)
) STRICT;

CREATE INDEX library_sources_owner_state_order
  ON library_sources(owner_id, state, approved_at DESC, source_id DESC);
CREATE INDEX library_source_events_owner_source_order
  ON library_source_events(owner_id, source_id, occurred_at, event_id);
CREATE INDEX source_ingestion_jobs_owner_state_order
  ON source_ingestion_jobs(owner_id, state, created_at, job_id);
CREATE INDEX source_item_versions_owner_source_observed
  ON source_item_versions(owner_id, source_id, observed_at DESC, item_id, version_id);

CREATE VIRTUAL TABLE library_sources_fts USING fts5(
  owner_id UNINDEXED,
  source_id UNINDEXED,
  title,
  description,
  tokenize = 'unicode61'
);

CREATE TRIGGER library_sources_fts_insert AFTER INSERT ON library_sources BEGIN
  INSERT INTO library_sources_fts(owner_id, source_id, title, description)
  VALUES (new.owner_id, new.source_id, new.title, new.description);
END;

CREATE TRIGGER library_sources_fts_update AFTER UPDATE OF title, description ON library_sources BEGIN
  DELETE FROM library_sources_fts
  WHERE owner_id = old.owner_id AND source_id = old.source_id;
  INSERT INTO library_sources_fts(owner_id, source_id, title, description)
  VALUES (new.owner_id, new.source_id, new.title, new.description);
END;

CREATE TRIGGER library_sources_fts_delete AFTER DELETE ON library_sources BEGIN
  DELETE FROM library_sources_fts
  WHERE owner_id = old.owner_id AND source_id = old.source_id;
END;
