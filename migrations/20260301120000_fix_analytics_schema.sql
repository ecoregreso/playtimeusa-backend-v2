-- Ensure analytics-related columns exist and backfill from legacy snake_case columns when present.

DO $$
BEGIN
  IF to_regclass('public.ledger_events') IS NOT NULL THEN
    ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS tenant_id UUID;
    ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS "ts" TIMESTAMPTZ;
    ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS "playerId" UUID;
    ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS "sessionId" VARCHAR(128);
    ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS "actionId" VARCHAR(128);
    ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS "agentId" INTEGER;
    ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS "cashierId" INTEGER;
    ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS "gameKey" VARCHAR(64);
    ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS "eventType" VARCHAR(32);
    ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS "amountCents" INTEGER;
    ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS "betCents" INTEGER;
    ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS "winCents" INTEGER;
    ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS "balanceCents" INTEGER;
    ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS source VARCHAR(64);
    ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS meta JSONB;
    ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ;
    ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ledger_events' AND column_name = 'player_id'
    ) THEN
      EXECUTE 'UPDATE ledger_events SET "playerId" = player_id WHERE "playerId" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ledger_events' AND column_name = 'session_id'
    ) THEN
      EXECUTE 'UPDATE ledger_events SET "sessionId" = session_id WHERE "sessionId" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ledger_events' AND column_name = 'action_id'
    ) THEN
      EXECUTE 'UPDATE ledger_events SET "actionId" = action_id WHERE "actionId" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ledger_events' AND column_name = 'agent_id'
    ) THEN
      EXECUTE 'UPDATE ledger_events SET "agentId" = agent_id WHERE "agentId" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ledger_events' AND column_name = 'cashier_id'
    ) THEN
      EXECUTE 'UPDATE ledger_events SET "cashierId" = cashier_id WHERE "cashierId" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ledger_events' AND column_name = 'game_key'
    ) THEN
      EXECUTE 'UPDATE ledger_events SET "gameKey" = game_key WHERE "gameKey" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ledger_events' AND column_name = 'event_type'
    ) THEN
      EXECUTE 'UPDATE ledger_events SET "eventType" = event_type WHERE "eventType" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ledger_events' AND column_name = 'amount_cents'
    ) THEN
      EXECUTE 'UPDATE ledger_events SET "amountCents" = amount_cents WHERE "amountCents" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ledger_events' AND column_name = 'bet_cents'
    ) THEN
      EXECUTE 'UPDATE ledger_events SET "betCents" = bet_cents WHERE "betCents" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ledger_events' AND column_name = 'win_cents'
    ) THEN
      EXECUTE 'UPDATE ledger_events SET "winCents" = win_cents WHERE "winCents" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ledger_events' AND column_name = 'balance_cents'
    ) THEN
      EXECUTE 'UPDATE ledger_events SET "balanceCents" = balance_cents WHERE "balanceCents" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ledger_events' AND column_name = 'metadata'
    ) THEN
      EXECUTE 'UPDATE ledger_events SET meta = metadata WHERE meta IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ledger_events' AND column_name = 'created_at'
    ) THEN
      EXECUTE 'UPDATE ledger_events SET "createdAt" = created_at WHERE "createdAt" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ledger_events' AND column_name = 'updated_at'
    ) THEN
      EXECUTE 'UPDATE ledger_events SET "updatedAt" = updated_at WHERE "updatedAt" IS NULL';
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.session_snapshots') IS NOT NULL THEN
    ALTER TABLE session_snapshots ADD COLUMN IF NOT EXISTS tenant_id UUID;
    ALTER TABLE session_snapshots ADD COLUMN IF NOT EXISTS "sessionId" VARCHAR(128);
    ALTER TABLE session_snapshots ADD COLUMN IF NOT EXISTS "playerId" UUID;
    ALTER TABLE session_snapshots ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMPTZ;
    ALTER TABLE session_snapshots ADD COLUMN IF NOT EXISTS "endedAt" TIMESTAMPTZ;
    ALTER TABLE session_snapshots ADD COLUMN IF NOT EXISTS "startBalanceCents" INTEGER;
    ALTER TABLE session_snapshots ADD COLUMN IF NOT EXISTS "endBalanceCents" INTEGER;
    ALTER TABLE session_snapshots ADD COLUMN IF NOT EXISTS "totalBetsCents" INTEGER;
    ALTER TABLE session_snapshots ADD COLUMN IF NOT EXISTS "totalWinsCents" INTEGER;
    ALTER TABLE session_snapshots ADD COLUMN IF NOT EXISTS "netCents" INTEGER;
    ALTER TABLE session_snapshots ADD COLUMN IF NOT EXISTS "gameCount" INTEGER;
    ALTER TABLE session_snapshots ADD COLUMN IF NOT EXISTS spins INTEGER;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'session_snapshots' AND column_name = 'session_id'
    ) THEN
      EXECUTE 'UPDATE session_snapshots SET "sessionId" = session_id WHERE "sessionId" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'session_snapshots' AND column_name = 'player_id'
    ) THEN
      EXECUTE 'UPDATE session_snapshots SET "playerId" = player_id WHERE "playerId" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'session_snapshots' AND column_name = 'started_at'
    ) THEN
      EXECUTE 'UPDATE session_snapshots SET "startedAt" = started_at WHERE "startedAt" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'session_snapshots' AND column_name = 'ended_at'
    ) THEN
      EXECUTE 'UPDATE session_snapshots SET "endedAt" = ended_at WHERE "endedAt" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'session_snapshots' AND column_name = 'start_balance_cents'
    ) THEN
      EXECUTE 'UPDATE session_snapshots SET "startBalanceCents" = start_balance_cents WHERE "startBalanceCents" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'session_snapshots' AND column_name = 'end_balance_cents'
    ) THEN
      EXECUTE 'UPDATE session_snapshots SET "endBalanceCents" = end_balance_cents WHERE "endBalanceCents" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'session_snapshots' AND column_name = 'total_bets_cents'
    ) THEN
      EXECUTE 'UPDATE session_snapshots SET "totalBetsCents" = total_bets_cents WHERE "totalBetsCents" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'session_snapshots' AND column_name = 'total_wins_cents'
    ) THEN
      EXECUTE 'UPDATE session_snapshots SET "totalWinsCents" = total_wins_cents WHERE "totalWinsCents" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'session_snapshots' AND column_name = 'net_cents'
    ) THEN
      EXECUTE 'UPDATE session_snapshots SET "netCents" = net_cents WHERE "netCents" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'session_snapshots' AND column_name = 'game_count'
    ) THEN
      EXECUTE 'UPDATE session_snapshots SET "gameCount" = game_count WHERE "gameCount" IS NULL';
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.game_configs') IS NOT NULL THEN
    ALTER TABLE game_configs ADD COLUMN IF NOT EXISTS tenant_id UUID;
    ALTER TABLE game_configs ADD COLUMN IF NOT EXISTS "gameKey" VARCHAR(64);
    ALTER TABLE game_configs ADD COLUMN IF NOT EXISTS provider VARCHAR(64);
    ALTER TABLE game_configs ADD COLUMN IF NOT EXISTS "expectedRtp" NUMERIC(6, 4);
    ALTER TABLE game_configs ADD COLUMN IF NOT EXISTS "volatilityLabel" VARCHAR(32);

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'game_configs' AND column_name = 'game_key'
    ) THEN
      EXECUTE 'UPDATE game_configs SET "gameKey" = game_key WHERE "gameKey" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'game_configs' AND column_name = 'expected_rtp'
    ) THEN
      EXECUTE 'UPDATE game_configs SET "expectedRtp" = expected_rtp WHERE "expectedRtp" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'game_configs' AND column_name = 'volatility_label'
    ) THEN
      EXECUTE 'UPDATE game_configs SET "volatilityLabel" = volatility_label WHERE "volatilityLabel" IS NULL';
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.api_error_events') IS NOT NULL THEN
    ALTER TABLE api_error_events ADD COLUMN IF NOT EXISTS tenant_id UUID;
    ALTER TABLE api_error_events ADD COLUMN IF NOT EXISTS ts TIMESTAMPTZ;
    ALTER TABLE api_error_events ADD COLUMN IF NOT EXISTS route VARCHAR(255);
    ALTER TABLE api_error_events ADD COLUMN IF NOT EXISTS method VARCHAR(12);
    ALTER TABLE api_error_events ADD COLUMN IF NOT EXISTS "statusCode" INTEGER;
    ALTER TABLE api_error_events ADD COLUMN IF NOT EXISTS message VARCHAR(255);
    ALTER TABLE api_error_events ADD COLUMN IF NOT EXISTS meta JSONB;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'api_error_events' AND column_name = 'status_code'
    ) THEN
      EXECUTE 'UPDATE api_error_events SET "statusCode" = status_code WHERE "statusCode" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'api_error_events' AND column_name = 'metadata'
    ) THEN
      EXECUTE 'UPDATE api_error_events SET meta = metadata WHERE meta IS NULL';
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.support_tickets') IS NOT NULL THEN
    ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS tenant_id UUID;
    ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS "playerId" UUID;
    ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS "assignedStaffId" INTEGER;
    ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS status VARCHAR(24);
    ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS priority VARCHAR(16);
    ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS category VARCHAR(64);
    ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMPTZ;
    ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS "closedAt" TIMESTAMPTZ;
    ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS meta JSONB;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'support_tickets' AND column_name = 'player_id'
    ) THEN
      EXECUTE 'UPDATE support_tickets SET "playerId" = player_id WHERE "playerId" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'support_tickets' AND column_name = 'assigned_staff_id'
    ) THEN
      EXECUTE 'UPDATE support_tickets SET "assignedStaffId" = assigned_staff_id WHERE "assignedStaffId" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'support_tickets' AND column_name = 'resolved_at'
    ) THEN
      EXECUTE 'UPDATE support_tickets SET "resolvedAt" = resolved_at WHERE "resolvedAt" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'support_tickets' AND column_name = 'closed_at'
    ) THEN
      EXECUTE 'UPDATE support_tickets SET "closedAt" = closed_at WHERE "closedAt" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'support_tickets' AND column_name = 'metadata'
    ) THEN
      EXECUTE 'UPDATE support_tickets SET meta = metadata WHERE meta IS NULL';
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.deposit_intents') IS NOT NULL THEN
    ALTER TABLE deposit_intents ADD COLUMN IF NOT EXISTS tenant_id UUID;
    ALTER TABLE deposit_intents ADD COLUMN IF NOT EXISTS credited_at TIMESTAMPTZ;
    ALTER TABLE deposit_intents ADD COLUMN IF NOT EXISTS metadata JSONB;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.withdrawal_intents') IS NOT NULL THEN
    ALTER TABLE withdrawal_intents ADD COLUMN IF NOT EXISTS tenant_id UUID;
    ALTER TABLE withdrawal_intents ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
    ALTER TABLE withdrawal_intents ADD COLUMN IF NOT EXISTS metadata JSONB;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.vouchers') IS NOT NULL THEN
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS "redeemedAt" TIMESTAMPTZ;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMPTZ;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS "bonusAmount" NUMERIC(18, 4);
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS "totalCredit" NUMERIC(18, 4);

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'vouchers' AND column_name = 'created_at'
    ) THEN
      EXECUTE 'UPDATE vouchers SET "createdAt" = created_at WHERE "createdAt" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'vouchers' AND column_name = 'updated_at'
    ) THEN
      EXECUTE 'UPDATE vouchers SET "updatedAt" = updated_at WHERE "updatedAt" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'vouchers' AND column_name = 'redeemed_at'
    ) THEN
      EXECUTE 'UPDATE vouchers SET "redeemedAt" = redeemed_at WHERE "redeemedAt" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'vouchers' AND column_name = 'expires_at'
    ) THEN
      EXECUTE 'UPDATE vouchers SET "expiresAt" = expires_at WHERE "expiresAt" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'vouchers' AND column_name = 'bonus_amount'
    ) THEN
      EXECUTE 'UPDATE vouchers SET "bonusAmount" = bonus_amount WHERE "bonusAmount" IS NULL';
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'vouchers' AND column_name = 'total_credit'
    ) THEN
      EXECUTE 'UPDATE vouchers SET "totalCredit" = total_credit WHERE "totalCredit" IS NULL';
    END IF;
  END IF;
END $$;
