-- Paired quiz variants retain independent review intervals and answer history.
CREATE TABLE learner_question_state (
  owner_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  knowledge_id TEXT NOT NULL,
  last_answer_correct INTEGER CHECK (last_answer_correct IS NULL OR last_answer_correct IN (0, 1)),
  scheduled_days INTEGER NOT NULL CHECK (scheduled_days >= 0),
  due_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, question_id)
) STRICT;

CREATE INDEX learner_question_knowledge ON learner_question_state(owner_id, knowledge_id);
