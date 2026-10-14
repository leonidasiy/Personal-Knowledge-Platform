PRAGMA foreign_keys = ON;

CREATE TABLE knowledge_workflow_progress (
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  current_url TEXT,
  page_title TEXT,
  section_title TEXT,
  stage TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,run_id),
  FOREIGN KEY(owner_id,run_id) REFERENCES knowledge_workflow_runs(owner_id,run_id)
) STRICT;

CREATE TRIGGER knowledge_workflow_progress_active_attempt_insert
BEFORE INSERT ON knowledge_workflow_progress
WHEN EXISTS(SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id=NEW.owner_id AND r.run_id=NEW.run_id AND r.state='abandoned')
 OR EXISTS(SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id=NEW.owner_id AND t.run_id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER knowledge_workflow_progress_active_attempt_update
BEFORE UPDATE ON knowledge_workflow_progress
WHEN EXISTS(SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id=NEW.owner_id AND r.run_id=NEW.run_id AND r.state='abandoned')
 OR EXISTS(SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id=NEW.owner_id AND t.run_id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'WorkflowAttemptAbandoned'); END;
