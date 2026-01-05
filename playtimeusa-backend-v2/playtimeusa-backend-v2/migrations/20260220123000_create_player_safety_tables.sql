CREATE TABLE IF NOT EXISTS safety_telemetry_events (
  id UUID PRIMARY KEY,
  "playerId" UUID,
  "sessionId" VARCHAR(128) NOT NULL,
  "gameKey" VARCHAR(64),
  "eventType" VARCHAR(16) NOT NULL,
  "betCents" INTEGER,
  "winCents" INTEGER,
  "balanceCents" INTEGER,
  "clientTs" TIMESTAMPTZ,
  meta JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS safety_telemetry_session_created_idx
  ON safety_telemetry_events ("sessionId", "createdAt");
CREATE INDEX IF NOT EXISTS safety_telemetry_player_created_idx
  ON safety_telemetry_events ("playerId", "createdAt");
CREATE INDEX IF NOT EXISTS safety_telemetry_game_created_idx
  ON safety_telemetry_events ("gameKey", "createdAt");

CREATE TABLE IF NOT EXISTS player_safety_limits (
  id UUID PRIMARY KEY,
  "playerId" UUID,
  "sessionId" VARCHAR(128) NOT NULL,
  "lossLimitCents" INTEGER NOT NULL,
  "lockedAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS player_safety_limits_session_idx
  ON player_safety_limits ("sessionId");
CREATE INDEX IF NOT EXISTS player_safety_limits_player_idx
  ON player_safety_limits ("playerId");

CREATE TABLE IF NOT EXISTS player_safety_actions (
  id UUID PRIMARY KEY,
  "playerId" UUID,
  "sessionId" VARCHAR(128) NOT NULL,
  "gameKey" VARCHAR(64),
  "actionType" VARCHAR(16) NOT NULL,
  "reasonCodes" JSONB NOT NULL,
  severity INTEGER NOT NULL,
  details JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS player_safety_actions_session_created_idx
  ON player_safety_actions ("sessionId", "createdAt");
CREATE INDEX IF NOT EXISTS player_safety_actions_player_created_idx
  ON player_safety_actions ("playerId", "createdAt");
CREATE INDEX IF NOT EXISTS player_safety_actions_type_created_idx
  ON player_safety_actions ("actionType", "createdAt");
