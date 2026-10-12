-- Initial quiz generation plus three retries; preserve prior attempts and cancellation fences.

CREATE TABLE knowledge_workflow_quiz_attempts_four_attempts (
  owner_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  knowledge_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1 AND attempt_number <= 4),
  draft_id TEXT,
  score INTEGER CHECK (score IS NULL OR (score >= 1 AND score <= 10)),
  feedback TEXT,
  failure_kind TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, attempt_id),
  UNIQUE (owner_id, run_id, knowledge_id, attempt_number),
  FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id)
) STRICT;

INSERT INTO knowledge_workflow_quiz_attempts_four_attempts SELECT * FROM knowledge_workflow_quiz_attempts;

CREATE TABLE knowledge_workflow_quiz_retry_attempts_four_attempts (
  owner_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  knowledge_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 4),
  draft_id TEXT,
  score INTEGER CHECK (score IS NULL OR (score BETWEEN 1 AND 10)),
  feedback TEXT,
  failure_kind TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, attempt_id),
  FOREIGN KEY (owner_id, run_id, knowledge_id, attempt_number)
    REFERENCES knowledge_workflow_quiz_attempts_four_attempts(owner_id, run_id, knowledge_id, attempt_number)
    ON DELETE CASCADE
) STRICT;

INSERT INTO knowledge_workflow_quiz_retry_attempts_four_attempts SELECT * FROM knowledge_workflow_quiz_retry_attempts;

CREATE TABLE knowledge_workflow_quizzes_four_attempts (
  owner_id TEXT NOT NULL,
  quiz_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  knowledge_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  draft_fingerprint TEXT NOT NULL,
  draft_json TEXT NOT NULL CHECK (json_valid(draft_json)),
  score INTEGER NOT NULL CHECK (score >= 8 AND score <= 10),
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1 AND attempt_number <= 4),
  status TEXT NOT NULL CHECK (status IN ('published', 'pending-review')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, quiz_id),
  UNIQUE (owner_id, run_id, knowledge_id),
  UNIQUE (owner_id, source_id, source_revision, draft_fingerprint),
  FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id)
) STRICT;

INSERT INTO knowledge_workflow_quizzes_four_attempts SELECT * FROM knowledge_workflow_quizzes;

DROP TABLE knowledge_workflow_quiz_retry_attempts;

DROP TABLE knowledge_workflow_quiz_attempts;

DROP TABLE knowledge_workflow_quizzes;

ALTER TABLE knowledge_workflow_quiz_attempts_four_attempts RENAME TO knowledge_workflow_quiz_attempts;

ALTER TABLE knowledge_workflow_quiz_retry_attempts_four_attempts RENAME TO knowledge_workflow_quiz_retry_attempts;

ALTER TABLE knowledge_workflow_quizzes_four_attempts RENAME TO knowledge_workflow_quizzes;

CREATE INDEX knowledge_workflow_quiz_attempts_owner_run
  ON knowledge_workflow_quiz_attempts(owner_id, run_id, knowledge_id, attempt_number);

CREATE INDEX knowledge_workflow_quiz_retry_attempts_parent
  ON knowledge_workflow_quiz_retry_attempts(owner_id, run_id, knowledge_id, attempt_number);

CREATE TRIGGER knowledge_workflow_quiz_attempts_active_attempt_insert
BEFORE INSERT ON knowledge_workflow_quiz_attempts
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER knowledge_workflow_quiz_attempts_active_attempt_update
BEFORE UPDATE ON knowledge_workflow_quiz_attempts
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER knowledge_workflow_quiz_retry_attempts_active_attempt_insert
BEFORE INSERT ON knowledge_workflow_quiz_retry_attempts
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER knowledge_workflow_quiz_retry_attempts_active_attempt_update
BEFORE UPDATE ON knowledge_workflow_quiz_retry_attempts
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER knowledge_workflow_quizzes_active_attempt_insert
BEFORE INSERT ON knowledge_workflow_quizzes
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER knowledge_workflow_quizzes_active_attempt_update
BEFORE UPDATE ON knowledge_workflow_quizzes
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;
