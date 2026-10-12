-- Page warnings belong to an attempt even when the page produces no knowledge points.
CREATE TABLE knowledge_workflow_page_image_warnings (
 owner_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 page_url TEXT NOT NULL,
 warnings_json TEXT NOT NULL CHECK (json_valid(warnings_json) AND json_type(warnings_json) = 'array'),
 PRIMARY KEY (owner_id, run_id, page_url),
 FOREIGN KEY (owner_id, run_id) REFERENCES knowledge_workflow_runs(owner_id, run_id) ON DELETE CASCADE
);
