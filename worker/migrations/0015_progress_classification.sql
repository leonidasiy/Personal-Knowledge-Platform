-- Historical optional measurements remain NULL; no inferred confidence/backfill.
ALTER TABLE learner_review_answers ADD COLUMN knowledge_id TEXT;
ALTER TABLE learner_review_answers ADD COLUMN confidence INTEGER
  CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100);
ALTER TABLE learner_review_answers ADD COLUMN elapsed_days REAL
  CHECK (elapsed_days IS NULL OR elapsed_days >= 0);
ALTER TABLE learner_review_answers ADD COLUMN previous_correct INTEGER
  CHECK (previous_correct IS NULL OR previous_correct IN (0, 1));
CREATE INDEX learner_answers_period ON learner_review_answers(owner_id, answered_at);

CREATE TABLE knowledge_classifications (
  owner_id TEXT NOT NULL,
  knowledge_id TEXT NOT NULL,
  classification_json TEXT NOT NULL CHECK (json_valid(classification_json)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, knowledge_id),
  FOREIGN KEY (owner_id, knowledge_id)
    REFERENCES extraction_knowledge_points(owner_id, knowledge_id) ON DELETE CASCADE
) STRICT;
