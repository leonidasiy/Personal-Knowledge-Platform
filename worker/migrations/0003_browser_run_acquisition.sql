PRAGMA foreign_keys = ON;

CREATE TABLE source_rights_registry (
  owner_id TEXT NOT NULL,
  registry_id TEXT NOT NULL,
  registry_version TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  canonical_root_url TEXT NOT NULL,
  storage_outcome TEXT NOT NULL CHECK (storage_outcome IN ('allowed', 'denied', 'unknown')),
  display_outcome TEXT NOT NULL CHECK (display_outcome IN ('allowed', 'denied', 'unknown')),
  transformation_outcome TEXT NOT NULL CHECK (transformation_outcome IN ('allowed', 'denied', 'unknown')),
  attribution_text TEXT NOT NULL CHECK (length(trim(attribution_text)) > 0),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  evidence_digest TEXT NOT NULL,
  assessor_id TEXT NOT NULL,
  assessor_version TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  expires_at TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'revoked')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, registry_id),
  FOREIGN KEY (owner_id, source_id)
    REFERENCES library_sources(owner_id, source_id)
) STRICT;

CREATE UNIQUE INDEX source_rights_registry_active_source
  ON source_rights_registry(owner_id, source_id, source_revision)
  WHERE state = 'active';

CREATE INDEX source_rights_registry_lookup
  ON source_rights_registry(owner_id, source_id, source_revision, state, expires_at, observed_at DESC);

CREATE TRIGGER source_rights_registry_active_guard
BEFORE INSERT ON source_rights_registry BEGIN
  SELECT RAISE(ABORT, 'rights-registry-source-mismatch') WHERE NOT EXISTS (
    SELECT 1 FROM library_sources
    WHERE owner_id = new.owner_id AND source_id = new.source_id
      AND state = 'active' AND revision = new.source_revision
      AND canonical_url = new.canonical_root_url
  );
END;

CREATE TABLE source_ingestion_resume_cursors (
  owner_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  cursor_version INTEGER NOT NULL CHECK (cursor_version >= 1),
  next_ordinal INTEGER NOT NULL CHECK (next_ordinal >= 0),
  pages_processed INTEGER NOT NULL CHECK (pages_processed >= 0),
  decoded_bytes INTEGER NOT NULL CHECK (decoded_bytes >= 0),
  redirects INTEGER NOT NULL CHECK (redirects >= 0),
  state TEXT NOT NULL CHECK (state IN ('ready', 'leased', 'completed', 'cancelled')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, job_id),
  FOREIGN KEY (owner_id, job_id)
    REFERENCES source_ingestion_jobs(owner_id, job_id),
  FOREIGN KEY (owner_id, source_id)
    REFERENCES library_sources(owner_id, source_id)
) STRICT;

CREATE TABLE source_ingestion_frontier (
  owner_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  url TEXT NOT NULL,
  depth INTEGER NOT NULL CHECK (depth >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'visited')),
  discovered_from_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, job_id, ordinal),
  UNIQUE (owner_id, job_id, url),
  FOREIGN KEY (owner_id, job_id)
    REFERENCES source_ingestion_jobs(owner_id, job_id)
) STRICT;

CREATE INDEX source_ingestion_frontier_next
  ON source_ingestion_frontier(owner_id, job_id, state, ordinal);

CREATE TABLE source_browser_run_daily_capacity (
  account_scope TEXT NOT NULL,
  utc_day TEXT NOT NULL,
  reserved_milliseconds INTEGER NOT NULL CHECK (reserved_milliseconds >= 0),
  active_sessions INTEGER NOT NULL CHECK (active_sessions >= 0),
  next_acquisition_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_scope, utc_day)
) STRICT;

CREATE TABLE source_browser_run_reservations (
  account_scope TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  utc_day TEXT NOT NULL,
  reserved_milliseconds INTEGER NOT NULL CHECK (reserved_milliseconds > 0),
  charged_milliseconds INTEGER CHECK (
    charged_milliseconds IS NULL OR
    (charged_milliseconds >= 0 AND charged_milliseconds <= reserved_milliseconds)
  ),
  daily_limit_milliseconds INTEGER NOT NULL CHECK (daily_limit_milliseconds > 0),
  maximum_concurrent_sessions INTEGER NOT NULL CHECK (maximum_concurrent_sessions > 0),
  minimum_launch_interval_milliseconds INTEGER NOT NULL CHECK (minimum_launch_interval_milliseconds > 0),
  reserved_at TEXT NOT NULL,
  next_eligible_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'closed', 'uncertain')),
  closed_at TEXT,
  PRIMARY KEY (account_scope, reservation_id),
  UNIQUE (account_scope, owner_id, job_id),
  FOREIGN KEY (owner_id, job_id)
    REFERENCES source_ingestion_jobs(owner_id, job_id)
) STRICT;

CREATE TRIGGER source_browser_run_reservation_capacity_guard
BEFORE INSERT ON source_browser_run_reservations BEGIN
  SELECT RAISE(ABORT, 'browser-run-capacity-missing') WHERE NOT EXISTS (
    SELECT 1 FROM source_browser_run_daily_capacity
    WHERE account_scope = new.account_scope AND utc_day = new.utc_day
  );
  SELECT RAISE(ABORT, 'browser-run-daily-budget-exceeded') WHERE (
    SELECT reserved_milliseconds FROM source_browser_run_daily_capacity
    WHERE account_scope = new.account_scope AND utc_day = new.utc_day
  ) + new.reserved_milliseconds > new.daily_limit_milliseconds
  ;
  SELECT RAISE(ABORT, 'browser-run-concurrency-exceeded') WHERE (
    SELECT active_sessions FROM source_browser_run_daily_capacity
    WHERE account_scope = new.account_scope AND utc_day = new.utc_day
  ) >= new.maximum_concurrent_sessions
  ;
  SELECT RAISE(ABORT, 'browser-run-launch-throttled') WHERE (
    SELECT next_acquisition_at FROM source_browser_run_daily_capacity
    WHERE account_scope = new.account_scope AND utc_day = new.utc_day
  ) > new.reserved_at
  ;
END;

CREATE TRIGGER source_browser_run_reservation_apply
AFTER INSERT ON source_browser_run_reservations BEGIN
  UPDATE source_browser_run_daily_capacity
  SET reserved_milliseconds = reserved_milliseconds + new.reserved_milliseconds,
      active_sessions = active_sessions + 1,
      next_acquisition_at = new.next_eligible_at,
      updated_at = new.reserved_at
  WHERE account_scope = new.account_scope AND utc_day = new.utc_day;
END;

CREATE TRIGGER source_browser_run_reservation_close
AFTER UPDATE OF state ON source_browser_run_reservations
WHEN old.state = 'active' AND new.state IN ('closed', 'uncertain') BEGIN
  UPDATE source_browser_run_daily_capacity
  SET reserved_milliseconds = reserved_milliseconds -
        (old.reserved_milliseconds - coalesce(new.charged_milliseconds, old.reserved_milliseconds)),
      active_sessions = active_sessions - 1,
      updated_at = coalesce(new.closed_at, new.reserved_at)
  WHERE account_scope = new.account_scope AND utc_day = new.utc_day;
END;
