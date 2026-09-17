PRAGMA foreign_keys = ON;

CREATE VIRTUAL TABLE knowledge_points_fts USING fts5(
  owner_id UNINDEXED,
  knowledge_id UNINDEXED,
  source_id UNINDEXED,
  summary,
  source_title,
  tokenize = 'unicode61'
);

INSERT INTO knowledge_points_fts(owner_id, knowledge_id, source_id, summary, source_title)
SELECT k.owner_id, k.knowledge_id, k.source_id,
  json_extract(k.point_json, '$.summary'), s.title
FROM extraction_knowledge_points k
JOIN library_sources s ON s.owner_id = k.owner_id AND s.source_id = k.source_id;

CREATE TRIGGER knowledge_points_fts_insert AFTER INSERT ON extraction_knowledge_points BEGIN
  INSERT INTO knowledge_points_fts(owner_id, knowledge_id, source_id, summary, source_title)
  SELECT new.owner_id, new.knowledge_id, new.source_id,
    json_extract(new.point_json, '$.summary'), s.title
  FROM library_sources s
  WHERE s.owner_id = new.owner_id AND s.source_id = new.source_id;
END;

CREATE TRIGGER knowledge_points_fts_update AFTER UPDATE OF point_json, source_id ON extraction_knowledge_points BEGIN
  DELETE FROM knowledge_points_fts
  WHERE owner_id = old.owner_id AND knowledge_id = old.knowledge_id;
  INSERT INTO knowledge_points_fts(owner_id, knowledge_id, source_id, summary, source_title)
  SELECT new.owner_id, new.knowledge_id, new.source_id,
    json_extract(new.point_json, '$.summary'), s.title
  FROM library_sources s
  WHERE s.owner_id = new.owner_id AND s.source_id = new.source_id;
END;

CREATE TRIGGER knowledge_points_fts_delete AFTER DELETE ON extraction_knowledge_points BEGIN
  DELETE FROM knowledge_points_fts
  WHERE owner_id = old.owner_id AND knowledge_id = old.knowledge_id;
END;

CREATE TRIGGER knowledge_points_fts_source_update AFTER UPDATE OF title ON library_sources BEGIN
  DELETE FROM knowledge_points_fts
  WHERE owner_id = old.owner_id AND source_id = old.source_id;
  INSERT INTO knowledge_points_fts(owner_id, knowledge_id, source_id, summary, source_title)
  SELECT k.owner_id, k.knowledge_id, k.source_id,
    json_extract(k.point_json, '$.summary'), new.title
  FROM extraction_knowledge_points k
  WHERE k.owner_id = new.owner_id AND k.source_id = new.source_id;
END;
