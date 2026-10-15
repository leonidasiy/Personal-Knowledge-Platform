-- Browser capacity is shared by crawl jobs and direct URL captures. Preserve all usage.
CREATE TABLE source_browser_run_reservations_next (
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
  UNIQUE (account_scope, owner_id, job_id)
) STRICT;

INSERT INTO source_browser_run_reservations_next SELECT * FROM source_browser_run_reservations;
DROP TABLE source_browser_run_reservations;
ALTER TABLE source_browser_run_reservations_next RENAME TO source_browser_run_reservations;

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
