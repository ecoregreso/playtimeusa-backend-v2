ALTER TABLE IF EXISTS ledger_events
  ADD COLUMN IF NOT EXISTS "actionId" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "source" VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS ledger_events_action_event_unique
  ON ledger_events ("actionId", "eventType");

DROP TABLE IF EXISTS safety_telemetry_events;
