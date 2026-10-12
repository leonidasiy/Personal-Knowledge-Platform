-- Fence late attempt writes atomically after cancellation. No live migration applied.

CREATE TRIGGER agent_memory_namespaces_active_attempt_insert
BEFORE INSERT ON agent_memory_namespaces
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER agent_memory_namespaces_active_attempt_update
BEFORE UPDATE ON agent_memory_namespaces
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER agent_shared_handoffs_active_attempt_insert
BEFORE INSERT ON agent_shared_handoffs
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER agent_shared_handoffs_active_attempt_update
BEFORE UPDATE ON agent_shared_handoffs
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER agent_event_ledger_active_attempt_insert
BEFORE INSERT ON agent_event_ledger
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER agent_event_ledger_active_attempt_update
BEFORE UPDATE ON agent_event_ledger
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER agent_compaction_records_active_attempt_insert
BEFORE INSERT ON agent_compaction_records
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER agent_compaction_records_active_attempt_update
BEFORE UPDATE ON agent_compaction_records
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER knowledge_workflow_rights_decisions_active_attempt_insert
BEFORE INSERT ON knowledge_workflow_rights_decisions
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER knowledge_workflow_rights_decisions_active_attempt_update
BEFORE UPDATE ON knowledge_workflow_rights_decisions
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER extraction_scratchpads_active_attempt_insert
BEFORE INSERT ON extraction_scratchpads
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER extraction_scratchpads_active_attempt_update
BEFORE UPDATE ON extraction_scratchpads
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER extraction_knowledge_points_active_attempt_insert
BEFORE INSERT ON extraction_knowledge_points
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER extraction_knowledge_points_active_attempt_update
BEFORE UPDATE ON extraction_knowledge_points
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

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

CREATE TRIGGER knowledge_workflow_restrictions_active_attempt_insert
BEFORE INSERT ON knowledge_workflow_restrictions
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER knowledge_workflow_restrictions_active_attempt_update
BEFORE UPDATE ON knowledge_workflow_restrictions
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER knowledge_workflow_media_assets_active_attempt_insert
BEFORE INSERT ON knowledge_workflow_media_assets
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER knowledge_workflow_media_assets_active_attempt_update
BEFORE UPDATE ON knowledge_workflow_media_assets
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER knowledge_workflow_materials_active_attempt_insert
BEFORE INSERT ON knowledge_workflow_materials
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER knowledge_workflow_materials_active_attempt_update
BEFORE UPDATE ON knowledge_workflow_materials
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

CREATE TRIGGER library_source_events_active_attempt_insert
BEFORE INSERT ON library_source_events
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER library_source_events_active_attempt_update
BEFORE UPDATE ON library_source_events
WHEN EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.state = 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER agent_memory_records_active_attempt_insert
BEFORE INSERT ON agent_memory_records
WHEN NOT EXISTS (SELECT 1 FROM agent_memory_namespaces p JOIN knowledge_workflow_runs r ON r.owner_id = p.owner_id AND r.run_id = p.run_id WHERE p.owner_id = NEW.owner_id AND p.namespace_id = NEW.namespace_id AND r.state != 'abandoned')
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER agent_memory_records_active_attempt_update
BEFORE UPDATE ON agent_memory_records
WHEN NOT EXISTS (SELECT 1 FROM agent_memory_namespaces p JOIN knowledge_workflow_runs r ON r.owner_id = p.owner_id AND r.run_id = p.run_id WHERE p.owner_id = NEW.owner_id AND p.namespace_id = NEW.namespace_id AND r.state != 'abandoned')
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER knowledge_workflow_media_derivatives_active_attempt_insert
BEFORE INSERT ON knowledge_workflow_media_derivatives
WHEN NOT EXISTS (SELECT 1 FROM knowledge_workflow_media_assets p JOIN knowledge_workflow_runs r ON r.owner_id = p.owner_id AND r.run_id = p.run_id WHERE p.owner_id = NEW.owner_id AND p.asset_id = NEW.asset_id AND r.state != 'abandoned')
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER knowledge_workflow_media_derivatives_active_attempt_update
BEFORE UPDATE ON knowledge_workflow_media_derivatives
WHEN NOT EXISTS (SELECT 1 FROM knowledge_workflow_media_assets p JOIN knowledge_workflow_runs r ON r.owner_id = p.owner_id AND r.run_id = p.run_id WHERE p.owner_id = NEW.owner_id AND p.asset_id = NEW.asset_id AND r.state != 'abandoned')
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

ALTER TABLE source_classifications ADD COLUMN run_id TEXT;
ALTER TABLE source_classification_review_issues ADD COLUMN run_id TEXT;

CREATE TRIGGER source_classifications_active_attempt_insert
BEFORE INSERT ON source_classifications
WHEN NEW.run_id IS NOT NULL AND (
  NOT EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.source_id = NEW.source_id AND r.source_revision = NEW.source_revision AND r.state <> 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER source_classifications_active_attempt_update
BEFORE UPDATE ON source_classifications
WHEN NEW.run_id IS NOT NULL AND (
  NOT EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.source_id = NEW.source_id AND r.source_revision = NEW.source_revision AND r.state <> 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER source_classification_review_issues_active_attempt_insert
BEFORE INSERT ON source_classification_review_issues
WHEN NEW.run_id IS NOT NULL AND (
  NOT EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.source_id = NEW.source_id AND r.source_revision = NEW.source_revision AND r.state <> 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;

CREATE TRIGGER source_classification_review_issues_active_attempt_update
BEFORE UPDATE ON source_classification_review_issues
WHEN NEW.run_id IS NOT NULL AND (
  NOT EXISTS (SELECT 1 FROM knowledge_workflow_runs r WHERE r.owner_id = NEW.owner_id AND r.run_id = NEW.run_id AND r.source_id = NEW.source_id AND r.source_revision = NEW.source_revision AND r.state <> 'abandoned')
  OR EXISTS (SELECT 1 FROM knowledge_workflow_run_tombstones t WHERE t.owner_id = NEW.owner_id AND t.run_id = NEW.run_id)
)
BEGIN SELECT RAISE(ABORT, 'WorkflowAttemptAbandoned'); END;
