PRAGMA foreign_keys = ON;

CREATE TABLE learner_knowledge_state (
  owner_id TEXT NOT NULL,
  knowledge_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  view_count INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  last_answer_correct INTEGER CHECK (last_answer_correct IS NULL OR last_answer_correct IN (0, 1)),
  scheduled_days INTEGER NOT NULL DEFAULT 0 CHECK (scheduled_days >= 0),
  due_at TEXT,
  studied_at TEXT,
  review_count INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  preference REAL NOT NULL DEFAULT 0 CHECK (preference >= -1 AND preference <= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, knowledge_id)
) STRICT;

CREATE TABLE learner_feed_batches (
  owner_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  learning_day TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'completed')),
  item_ids_json TEXT NOT NULL CHECK (json_valid(item_ids_json)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (owner_id, batch_id),
  UNIQUE (owner_id, idempotency_key)
) STRICT;

CREATE TABLE learner_review_batches (
  owner_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  learning_day TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'completed')),
  question_ids_json TEXT NOT NULL CHECK (json_valid(question_ids_json)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (owner_id, batch_id),
  UNIQUE (owner_id, idempotency_key)
) STRICT;

CREATE TABLE learner_review_answers (
  owner_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  selected_choice_ids_json TEXT NOT NULL CHECK (json_valid(selected_choice_ids_json)),
  correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
  answered_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, batch_id, question_id),
  FOREIGN KEY (owner_id, batch_id) REFERENCES learner_review_batches(owner_id, batch_id)
) STRICT;

CREATE TABLE learner_preference_feedback (
  owner_id TEXT NOT NULL,
  knowledge_id TEXT NOT NULL,
  preference REAL NOT NULL CHECK (preference >= -1 AND preference <= 1),
  choice TEXT NOT NULL CHECK (choice IN ('more', 'less')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, knowledge_id)
) STRICT;

CREATE TABLE learner_batch_commands (
  owner_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_kind TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, idempotency_key)
) STRICT;

CREATE INDEX learner_knowledge_due
  ON learner_knowledge_state(owner_id, due_at, studied_at, knowledge_id);
CREATE INDEX learner_feed_current
  ON learner_feed_batches(owner_id, created_at DESC, batch_id);
CREATE INDEX learner_review_current
  ON learner_review_batches(owner_id, created_at DESC, batch_id);
