-- Local-only migration. Attempt reservations survive resume; cancellation fences writes.
CREATE TABLE knowledge_workflow_image_attempts (
 owner_id TEXT NOT NULL, run_id TEXT NOT NULL, page_url TEXT NOT NULL,
 attempt_key TEXT NOT NULL, policy_version TEXT NOT NULL, policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
 evaluations INTEGER NOT NULL CHECK(evaluations>=0), decoded_bytes INTEGER NOT NULL CHECK(decoded_bytes>=0),
 output_json TEXT CHECK(output_json IS NULL OR json_valid(output_json)),
 deadline_at_ms INTEGER NOT NULL CHECK(deadline_at_ms>0), settled INTEGER NOT NULL CHECK(settled IN (0,1)),
 PRIMARY KEY(owner_id,run_id,page_url,attempt_key),
 FOREIGN KEY(owner_id,run_id) REFERENCES knowledge_workflow_runs(owner_id,run_id) ON DELETE CASCADE
);
