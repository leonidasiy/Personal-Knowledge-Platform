PRAGMA foreign_keys = ON;

CREATE TABLE source_classifications (
  owner_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  main_subject TEXT NOT NULL,
  topic TEXT NOT NULL CHECK (length(topic) BETWEEN 1 AND 120),
  classification_revision INTEGER NOT NULL CHECK (classification_revision >= 1),
  origin TEXT NOT NULL CHECK (origin IN ('agent', 'manual', 'backfill')),
  status TEXT NOT NULL CHECK (status IN ('classified', 'needs-review')),
  legacy_audit_json TEXT NOT NULL CHECK (json_valid(legacy_audit_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, source_id),
  FOREIGN KEY (owner_id, source_id) REFERENCES library_sources(owner_id, source_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE source_classification_review_issues (
  owner_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  issue_kind TEXT NOT NULL CHECK (issue_kind IN ('inference-failed', 'legacy-conflict', 'legacy-unclassified')),
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, source_id, source_revision),
  FOREIGN KEY (owner_id, source_id) REFERENCES library_sources(owner_id, source_id) ON DELETE CASCADE
) STRICT;

CREATE VIRTUAL TABLE knowledge_points_search_fts USING fts5(
  owner_id UNINDEXED,
  knowledge_id UNINDEXED,
  source_id UNINDEXED,
  summary,
  source_title,
  source_topic,
  tokenize = 'unicode61'
);

INSERT INTO knowledge_points_search_fts(owner_id, knowledge_id, source_id, summary, source_title, source_topic)
SELECT k.owner_id, k.knowledge_id, k.source_id,
  json_extract(k.point_json, '$.summary'), s.title, COALESCE(c.topic, '')
FROM extraction_knowledge_points k
JOIN library_sources s ON s.owner_id = k.owner_id AND s.source_id = k.source_id
LEFT JOIN source_classifications c ON c.owner_id = s.owner_id AND c.source_id = s.source_id;

CREATE TRIGGER knowledge_points_search_fts_insert AFTER INSERT ON extraction_knowledge_points BEGIN
  INSERT INTO knowledge_points_search_fts(owner_id, knowledge_id, source_id, summary, source_title, source_topic)
  SELECT new.owner_id, new.knowledge_id, new.source_id,
    json_extract(new.point_json, '$.summary'), s.title, COALESCE(c.topic, '')
  FROM library_sources s
  LEFT JOIN source_classifications c ON c.owner_id = s.owner_id AND c.source_id = s.source_id
  WHERE s.owner_id = new.owner_id AND s.source_id = new.source_id;
END;

CREATE TRIGGER knowledge_points_search_fts_update AFTER UPDATE OF point_json, source_id ON extraction_knowledge_points BEGIN
  DELETE FROM knowledge_points_search_fts WHERE owner_id = old.owner_id AND knowledge_id = old.knowledge_id;
  INSERT INTO knowledge_points_search_fts(owner_id, knowledge_id, source_id, summary, source_title, source_topic)
  SELECT new.owner_id, new.knowledge_id, new.source_id,
    json_extract(new.point_json, '$.summary'), s.title, COALESCE(c.topic, '')
  FROM library_sources s
  LEFT JOIN source_classifications c ON c.owner_id = s.owner_id AND c.source_id = s.source_id
  WHERE s.owner_id = new.owner_id AND s.source_id = new.source_id;
END;

CREATE TRIGGER knowledge_points_search_fts_delete AFTER DELETE ON extraction_knowledge_points BEGIN
  DELETE FROM knowledge_points_search_fts WHERE owner_id = old.owner_id AND knowledge_id = old.knowledge_id;
END;

CREATE TRIGGER knowledge_points_search_fts_source_update AFTER UPDATE OF title ON library_sources BEGIN
  DELETE FROM knowledge_points_search_fts WHERE owner_id = old.owner_id AND source_id = old.source_id;
  INSERT INTO knowledge_points_search_fts(owner_id, knowledge_id, source_id, summary, source_title, source_topic)
  SELECT k.owner_id, k.knowledge_id, k.source_id,
    json_extract(k.point_json, '$.summary'), new.title, COALESCE(c.topic, '')
  FROM extraction_knowledge_points k
  LEFT JOIN source_classifications c ON c.owner_id = new.owner_id AND c.source_id = new.source_id
  WHERE k.owner_id = new.owner_id AND k.source_id = new.source_id;
END;

CREATE TRIGGER knowledge_points_search_fts_classification_insert AFTER INSERT ON source_classifications BEGIN
  DELETE FROM knowledge_points_search_fts WHERE owner_id = new.owner_id AND source_id = new.source_id;
  INSERT INTO knowledge_points_search_fts(owner_id, knowledge_id, source_id, summary, source_title, source_topic)
  SELECT k.owner_id, k.knowledge_id, k.source_id,
    json_extract(k.point_json, '$.summary'), s.title, new.topic
  FROM extraction_knowledge_points k
  JOIN library_sources s ON s.owner_id = k.owner_id AND s.source_id = k.source_id
  WHERE k.owner_id = new.owner_id AND k.source_id = new.source_id;
END;

CREATE TRIGGER knowledge_points_search_fts_classification_update AFTER UPDATE OF topic ON source_classifications BEGIN
  DELETE FROM knowledge_points_search_fts WHERE owner_id = old.owner_id AND source_id = old.source_id;
  INSERT INTO knowledge_points_search_fts(owner_id, knowledge_id, source_id, summary, source_title, source_topic)
  SELECT k.owner_id, k.knowledge_id, k.source_id,
    json_extract(k.point_json, '$.summary'), s.title, new.topic
  FROM extraction_knowledge_points k
  JOIN library_sources s ON s.owner_id = k.owner_id AND s.source_id = k.source_id
  WHERE k.owner_id = new.owner_id AND k.source_id = new.source_id;
END;

CREATE TRIGGER knowledge_points_search_fts_classification_delete AFTER DELETE ON source_classifications BEGIN
  DELETE FROM knowledge_points_search_fts WHERE owner_id = old.owner_id AND source_id = old.source_id;
  INSERT INTO knowledge_points_search_fts(owner_id, knowledge_id, source_id, summary, source_title, source_topic)
  SELECT k.owner_id, k.knowledge_id, k.source_id,
    json_extract(k.point_json, '$.summary'), s.title, ''
  FROM extraction_knowledge_points k
  JOIN library_sources s ON s.owner_id = k.owner_id AND s.source_id = k.source_id
  WHERE k.owner_id = old.owner_id AND k.source_id = old.source_id;
END;
