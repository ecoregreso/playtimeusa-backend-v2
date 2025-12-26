CREATE TABLE IF NOT EXISTS ledger_events (
  id UUID PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "playerId" UUID,
  "sessionId" VARCHAR(128),
  "agentId" INTEGER,
  "cashierId" INTEGER,
  "gameKey" VARCHAR(64),
  "eventType" VARCHAR(32) NOT NULL,
  "amountCents" INTEGER,
  "betCents" INTEGER,
  "winCents" INTEGER,
  "balanceCents" INTEGER,
  meta JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ledger_events_ts_idx ON ledger_events (ts);
CREATE INDEX IF NOT EXISTS ledger_events_player_ts_idx ON ledger_events ("playerId", ts);
CREATE INDEX IF NOT EXISTS ledger_events_session_ts_idx ON ledger_events ("sessionId", ts);
CREATE INDEX IF NOT EXISTS ledger_events_game_ts_idx ON ledger_events ("gameKey", ts);
CREATE INDEX IF NOT EXISTS ledger_events_type_ts_idx ON ledger_events ("eventType", ts);

CREATE TABLE IF NOT EXISTS session_snapshots (
  id UUID PRIMARY KEY,
  "sessionId" VARCHAR(128) NOT NULL,
  "playerId" UUID NOT NULL,
  "startedAt" TIMESTAMPTZ NOT NULL,
  "endedAt" TIMESTAMPTZ NOT NULL,
  "startBalanceCents" INTEGER,
  "endBalanceCents" INTEGER,
  "totalBetsCents" INTEGER NOT NULL DEFAULT 0,
  "totalWinsCents" INTEGER NOT NULL DEFAULT 0,
  "netCents" INTEGER NOT NULL DEFAULT 0,
  "gameCount" INTEGER NOT NULL DEFAULT 0,
  spins INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS session_snapshots_started_idx ON session_snapshots ("startedAt");
CREATE INDEX IF NOT EXISTS session_snapshots_ended_idx ON session_snapshots ("endedAt");
CREATE INDEX IF NOT EXISTS session_snapshots_player_started_idx ON session_snapshots ("playerId", "startedAt");

CREATE TABLE IF NOT EXISTS game_configs (
  id UUID PRIMARY KEY,
  "gameKey" VARCHAR(64) NOT NULL UNIQUE,
  provider VARCHAR(64),
  "expectedRtp" NUMERIC(6, 4),
  "volatilityLabel" VARCHAR(32),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS game_configs_game_key_idx ON game_configs ("gameKey");
CREATE INDEX IF NOT EXISTS game_configs_provider_idx ON game_configs (provider);

CREATE TABLE IF NOT EXISTS api_error_events (
  id UUID PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  route VARCHAR(255),
  method VARCHAR(12),
  "statusCode" INTEGER,
  message VARCHAR(255),
  meta JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS api_error_events_ts_idx ON api_error_events (ts);
CREATE INDEX IF NOT EXISTS api_error_events_route_ts_idx ON api_error_events (route, ts);

CREATE TABLE IF NOT EXISTS support_tickets (
  id UUID PRIMARY KEY,
  "playerId" UUID,
  "assignedStaffId" INTEGER,
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  priority VARCHAR(16),
  category VARCHAR(64),
  "resolvedAt" TIMESTAMPTZ,
  "closedAt" TIMESTAMPTZ,
  meta JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets (status);
CREATE INDEX IF NOT EXISTS support_tickets_assigned_idx ON support_tickets ("assignedStaffId");
CREATE INDEX IF NOT EXISTS support_tickets_created_idx ON support_tickets ("createdAt");
