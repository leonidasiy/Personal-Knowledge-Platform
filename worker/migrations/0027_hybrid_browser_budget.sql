-- Full possible session costs remain reserved after failed or unknown launches.
CREATE TABLE knowledge_workflow_browser_credit_reservations (
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  ttl_seconds INTEGER NOT NULL CHECK (ttl_seconds > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, run_id, reservation_id),
  CHECK (credits = 2 * ((ttl_seconds + 59) / 60)),
  FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id)
) STRICT;
