-- Additive only: existing rows remain unchanged and unverified for new delivery.
ALTER TABLE knowledge_workflow_media_assets ADD COLUMN binding_json TEXT CHECK (binding_json IS NULL OR json_valid(binding_json));
ALTER TABLE knowledge_workflow_media_assets ADD COLUMN source_revision INTEGER CHECK (source_revision IS NULL OR source_revision >= 1);
ALTER TABLE knowledge_workflow_media_derivatives ADD COLUMN digest TEXT;
