-- For a NEW empty self-host database and private bucket only.
-- Owner ID and R2 scope must match wrangler.self-host.jsonc.
PRAGMA foreign_keys = ON;

INSERT INTO interest_areas (
  owner_id,
  interest_area_id,
  label,
  provenance_json,
  created_at,
  updated_at
) VALUES (
  'self-host-owner-v1',
  'music',
  'Music',
  '{"kind":"deployment-configuration","reference":"Self-host setup: initial Music interest area"}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
) ON CONFLICT(owner_id, interest_area_id) DO NOTHING;

INSERT INTO source_r2_account_capacity (
  account_scope,
  stored_bytes,
  observed_at,
  updated_at
) VALUES (
  'self-host-r2-v1',
  0,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
) ON CONFLICT(account_scope) DO NOTHING;

INSERT INTO source_r2_monthly_capacity (
  account_scope,
  usage_month,
  class_a_operations,
  class_b_operations,
  updated_at
) VALUES (
  'self-host-r2-v1',
  strftime('%Y-%m', 'now'),
  0,
  0,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
) ON CONFLICT(account_scope, usage_month) DO NOTHING;
