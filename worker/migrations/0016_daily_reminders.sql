CREATE TABLE daily_reminders (
  owner_id TEXT NOT NULL,
  device_id TEXT NOT NULL CHECK (length(device_id) = 36),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  reminder_time TEXT NOT NULL CHECK (reminder_time GLOB '[0-2][0-9]:[0-5][0-9]' AND reminder_time < '24:00'),
  time_zone TEXT NOT NULL,
  skipped_date TEXT,
  endpoint TEXT,
  p256dh TEXT,
  auth TEXT,
  last_status TEXT CHECK (last_status IS NULL OR last_status IN ('enabled', 'skipped', 'sent', 'delivery-failed', 'disabled-expired')),
  last_reminded_date TEXT,
  last_test_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, device_id),
  CHECK (enabled = 0 OR (endpoint IS NOT NULL AND p256dh IS NOT NULL AND auth IS NOT NULL))
) STRICT;
CREATE INDEX daily_reminders_enabled ON daily_reminders(enabled);
