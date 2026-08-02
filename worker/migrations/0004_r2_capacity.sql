PRAGMA foreign_keys = ON;

CREATE TABLE source_r2_account_capacity (
  account_scope TEXT PRIMARY KEY,
  stored_bytes INTEGER NOT NULL CHECK (stored_bytes >= 0),
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE source_r2_monthly_capacity (
  account_scope TEXT NOT NULL,
  usage_month TEXT NOT NULL,
  class_a_operations INTEGER NOT NULL CHECK (class_a_operations >= 0),
  class_b_operations INTEGER NOT NULL CHECK (class_b_operations >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_scope, usage_month),
  FOREIGN KEY (account_scope) REFERENCES source_r2_account_capacity(account_scope)
) STRICT;

CREATE TABLE source_r2_object_ledger (
  account_scope TEXT NOT NULL,
  object_key TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  state TEXT NOT NULL CHECK (state IN (
    'stored', 'write-pending', 'read-pending', 'delete-pending',
    'write-uncertain', 'read-uncertain', 'delete-uncertain'
  )),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_scope, object_key),
  FOREIGN KEY (account_scope) REFERENCES source_r2_account_capacity(account_scope)
) STRICT;

CREATE TABLE source_r2_reservations (
  account_scope TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('write', 'read', 'delete')),
  expected_stored_bytes INTEGER NOT NULL CHECK (expected_stored_bytes >= 0),
  usage_month TEXT NOT NULL,
  stored_bytes_limit INTEGER NOT NULL CHECK (stored_bytes_limit > 0),
  class_a_limit INTEGER NOT NULL CHECK (class_a_limit > 0),
  class_b_limit INTEGER NOT NULL CHECK (class_b_limit > 0),
  reserved_at TEXT NOT NULL,
  observation_stale_after TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'closed', 'uncertain')),
  outcome TEXT CHECK (outcome IN ('completed', 'not-started', 'uncertain')),
  measured_stored_bytes INTEGER CHECK (measured_stored_bytes >= 0),
  closed_at TEXT,
  PRIMARY KEY (account_scope, reservation_id),
  FOREIGN KEY (account_scope, usage_month)
    REFERENCES source_r2_monthly_capacity(account_scope, usage_month)
) STRICT;

CREATE TRIGGER source_r2_reservation_guard
BEFORE INSERT ON source_r2_reservations BEGIN
  SELECT RAISE(ABORT, 'r2-capacity-observation-stale') WHERE NOT EXISTS (
    SELECT 1 FROM source_r2_account_capacity
    WHERE account_scope = new.account_scope
  );
  SELECT RAISE(ABORT, 'r2-capacity-observation-stale') WHERE (
    SELECT observed_at FROM source_r2_account_capacity
    WHERE account_scope = new.account_scope
  ) < new.observation_stale_after
  ;
  SELECT RAISE(ABORT, 'r2-capacity-usage-uncertain') WHERE EXISTS (
    SELECT 1 FROM source_r2_object_ledger
    WHERE account_scope = new.account_scope
      AND object_key = new.object_key
      AND state LIKE '%-uncertain'
  );
  SELECT RAISE(ABORT, 'r2-capacity-conflict')
  WHERE new.operation = 'write' AND EXISTS (
    SELECT 1 FROM source_r2_object_ledger
    WHERE account_scope = new.account_scope AND object_key = new.object_key
  );
  SELECT RAISE(ABORT, 'r2-capacity-conflict')
  WHERE new.operation IN ('read', 'delete') AND NOT EXISTS (
    SELECT 1 FROM source_r2_object_ledger
    WHERE account_scope = new.account_scope
      AND object_key = new.object_key AND state = 'stored'
  );
  SELECT RAISE(ABORT, 'r2-storage-capacity-exceeded') WHERE (
    SELECT stored_bytes FROM source_r2_account_capacity
    WHERE account_scope = new.account_scope
  ) + CASE WHEN new.operation = 'write' THEN new.expected_stored_bytes ELSE 0 END
    > new.stored_bytes_limit
  ;
  SELECT RAISE(ABORT, 'r2-class-a-exceeded') WHERE (
    SELECT class_a_operations FROM source_r2_monthly_capacity
    WHERE account_scope = new.account_scope AND usage_month = new.usage_month
  ) + CASE WHEN new.operation IN ('write', 'delete') THEN 1 ELSE 0 END
    > new.class_a_limit
  ;
  SELECT RAISE(ABORT, 'r2-class-b-exceeded') WHERE (
    SELECT class_b_operations FROM source_r2_monthly_capacity
    WHERE account_scope = new.account_scope AND usage_month = new.usage_month
  ) + CASE WHEN new.operation = 'read' THEN 1 ELSE 0 END
    > new.class_b_limit
  ;
END;

CREATE TRIGGER source_r2_reservation_apply
AFTER INSERT ON source_r2_reservations BEGIN
  UPDATE source_r2_account_capacity
  SET stored_bytes = stored_bytes +
        CASE WHEN new.operation = 'write' THEN new.expected_stored_bytes ELSE 0 END,
      updated_at = new.reserved_at
  WHERE account_scope = new.account_scope;
  UPDATE source_r2_monthly_capacity
  SET class_a_operations = class_a_operations +
        CASE WHEN new.operation IN ('write', 'delete') THEN 1 ELSE 0 END,
      class_b_operations = class_b_operations +
        CASE WHEN new.operation = 'read' THEN 1 ELSE 0 END,
      updated_at = new.reserved_at
  WHERE account_scope = new.account_scope AND usage_month = new.usage_month;
  INSERT INTO source_r2_object_ledger
    (account_scope, object_key, byte_size, state, updated_at)
  SELECT new.account_scope, new.object_key, new.expected_stored_bytes,
    'write-pending', new.reserved_at WHERE new.operation = 'write';
  UPDATE source_r2_object_ledger
  SET state = new.operation || '-pending', updated_at = new.reserved_at
  WHERE account_scope = new.account_scope AND object_key = new.object_key
    AND new.operation IN ('read', 'delete');
END;

CREATE TRIGGER source_r2_reservation_close
AFTER UPDATE OF state ON source_r2_reservations
WHEN old.state = 'active' AND new.state IN ('closed', 'uncertain') BEGIN
  UPDATE source_r2_account_capacity
  SET stored_bytes = stored_bytes +
    CASE
      WHEN new.outcome = 'not-started' AND new.operation = 'write'
        THEN -new.expected_stored_bytes
      WHEN new.outcome = 'completed' AND new.operation = 'write'
        THEN new.measured_stored_bytes - new.expected_stored_bytes
      WHEN new.outcome = 'completed' AND new.operation = 'delete'
        THEN -(SELECT byte_size FROM source_r2_object_ledger
          WHERE account_scope = new.account_scope AND object_key = new.object_key)
      ELSE 0
    END,
    updated_at = new.closed_at
  WHERE account_scope = new.account_scope;
  UPDATE source_r2_monthly_capacity
  SET class_a_operations = class_a_operations -
      CASE WHEN new.outcome = 'not-started' AND new.operation IN ('write', 'delete') THEN 1 ELSE 0 END,
    class_b_operations = class_b_operations -
      CASE WHEN new.outcome = 'not-started' AND new.operation = 'read' THEN 1 ELSE 0 END,
    updated_at = new.closed_at
  WHERE account_scope = new.account_scope AND usage_month = new.usage_month;
  DELETE FROM source_r2_object_ledger
  WHERE account_scope = new.account_scope AND object_key = new.object_key
    AND ((new.outcome = 'not-started' AND new.operation = 'write') OR
      (new.outcome = 'completed' AND new.operation = 'delete'));
  UPDATE source_r2_object_ledger
  SET byte_size = CASE WHEN new.operation = 'write' AND new.outcome = 'completed'
        THEN new.measured_stored_bytes ELSE byte_size END,
      state = CASE WHEN new.outcome = 'uncertain'
        THEN new.operation || '-uncertain' ELSE 'stored' END,
      updated_at = new.closed_at
  WHERE account_scope = new.account_scope AND object_key = new.object_key;
END;
