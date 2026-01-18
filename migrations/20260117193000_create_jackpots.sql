CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Core jackpot state
CREATE TABLE IF NOT EXISTS jackpots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(16) NOT NULL, -- hourly | daily | weekly
  tenant_id UUID NULL REFERENCES tenants(id) ON DELETE CASCADE,
  current_pot_cents BIGINT NOT NULL DEFAULT 0,
  trigger_cents BIGINT NOT NULL DEFAULT 0,
  range_min_cents BIGINT NOT NULL DEFAULT 0,
  range_max_cents BIGINT NOT NULL DEFAULT 0,
  contribution_bps INTEGER NOT NULL DEFAULT 0, -- basis points (1% = 100)
  last_hit_at TIMESTAMPTZ NULL,
  next_draw_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS jackpots_type_tenant_idx ON jackpots (type, tenant_id);

-- Record jackpot hits/payouts
CREATE TABLE IF NOT EXISTS jackpot_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jackpot_id UUID NOT NULL REFERENCES jackpots(id) ON DELETE CASCADE,
  tenant_id UUID NULL REFERENCES tenants(id) ON DELETE CASCADE,
  player_id UUID NULL,
  event_type VARCHAR(16) NOT NULL DEFAULT 'hit',
  amount_cents BIGINT NOT NULL DEFAULT 0,
  pot_before_cents BIGINT NOT NULL DEFAULT 0,
  pot_after_cents BIGINT NOT NULL DEFAULT 0,
  metadata JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS jackpot_events_jackpot_idx ON jackpot_events (jackpot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jackpot_events_tenant_idx ON jackpot_events (tenant_id, created_at DESC);

-- Aggregate contributions per day per jackpot for charting
CREATE TABLE IF NOT EXISTS jackpot_contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jackpot_id UUID NOT NULL REFERENCES jackpots(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  amount_cents BIGINT NOT NULL DEFAULT 0,
  contributions_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (jackpot_id, day)
);

CREATE INDEX IF NOT EXISTS jackpot_contrib_day_idx ON jackpot_contributions (jackpot_id, day);
