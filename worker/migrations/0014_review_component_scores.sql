ALTER TABLE learner_review_answers ADD COLUMN score REAL CHECK (score IS NULL OR (score >= 0 AND score <= 1));
