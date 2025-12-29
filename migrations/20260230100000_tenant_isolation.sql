CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS distributors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  distributor_id UUID NULL REFERENCES distributors(id),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tenants_name_idx ON tenants (name);
CREATE INDEX IF NOT EXISTS tenants_distributor_idx ON tenants (distributor_id);

CREATE TABLE IF NOT EXISTS tenant_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  balance_cents BIGINT NOT NULL DEFAULT 0,
  currency VARCHAR(16) NOT NULL DEFAULT 'FUN',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tenant_wallets_tenant_idx ON tenant_wallets (tenant_id);

CREATE TABLE IF NOT EXISTS tenant_voucher_pools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pool_balance_cents BIGINT NOT NULL DEFAULT 0,
  currency VARCHAR(16) NOT NULL DEFAULT 'FUN',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tenant_voucher_pools_tenant_idx ON tenant_voucher_pools (tenant_id);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id INTEGER NULL,
  action_type VARCHAR(64) NOT NULL,
  amount_cents BIGINT NOT NULL,
  memo TEXT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS credit_ledger_tenant_idx ON credit_ledger (tenant_id);
CREATE INDEX IF NOT EXISTS credit_ledger_action_idx ON credit_ledger (action_type);

DO $$
DECLARE
  default_tenant UUID;
BEGIN
  SELECT id INTO default_tenant FROM tenants WHERE name = 'Default' LIMIT 1;
  IF default_tenant IS NULL THEN
    INSERT INTO tenants (name, status) VALUES ('Default', 'active') RETURNING id INTO default_tenant;
  END IF;

  -- tenant_id column + backfill
  PERFORM 1;
  FOR table_name IN SELECT unnest(ARRAY[
    'users',
    'wallets',
    'transactions',
    'vouchers',
    'game_rounds',
    'sessions',
    'deposit_intents',
    'withdrawal_intents',
    'ledger_events',
    'session_snapshots',
    'game_configs',
    'api_error_events',
    'support_tickets',
    'player_safety_limits',
    'player_safety_actions',
    'staff_users',
    'staff_keys',
    'staff_messages',
    'staff_push_devices',
    'purchase_orders',
    'purchase_order_messages',
    'tenant_wallets',
    'tenant_voucher_pools',
    'credit_ledger'
  ]) LOOP
    IF to_regclass(table_name) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id UUID', table_name);
      EXECUTE format('UPDATE %I SET tenant_id = $1 WHERE tenant_id IS NULL', table_name) USING default_tenant;
      EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT (current_setting(''app.tenant_id'', true))::uuid', table_name);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', table_name);
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = table_name || '_tenant_id_fkey'
      ) THEN
        EXECUTE format(
          'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE',
          table_name,
          table_name || '_tenant_id_fkey'
        );
      END IF;
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id)', table_name || '_tenant_id_idx', table_name);
    END IF;
  END LOOP;

  IF to_regclass('staff_users') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS distributor_id UUID';
    EXECUTE 'CREATE INDEX IF NOT EXISTS staff_users_distributor_idx ON staff_users (distributor_id)';
  END IF;
END $$;

-- Drop legacy unique constraints (non-tenant scoped)
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'users' AND c.contype = 'u'
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.conrelid
        AND a.attnum = ANY (c.conkey)
        AND a.attname IN ('email', 'username')
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.conrelid
        AND a.attnum = ANY (c.conkey)
        AND a.attname = 'tenant_id'
    ) THEN
      EXECUTE format('ALTER TABLE users DROP CONSTRAINT IF EXISTS %I', r.conname);
    END IF;
  END LOOP;

  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'vouchers' AND c.contype = 'u'
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.conrelid
        AND a.attnum = ANY (c.conkey)
        AND a.attname = 'code'
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.conrelid
        AND a.attnum = ANY (c.conkey)
        AND a.attname = 'tenant_id'
    ) THEN
      EXECUTE format('ALTER TABLE vouchers DROP CONSTRAINT IF EXISTS %I', r.conname);
    END IF;
  END LOOP;

  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'staff_users' AND c.contype = 'u'
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.conrelid
        AND a.attnum = ANY (c.conkey)
        AND a.attname = 'username'
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.conrelid
        AND a.attnum = ANY (c.conkey)
        AND a.attname = 'tenant_id'
    ) THEN
      EXECUTE format('ALTER TABLE staff_users DROP CONSTRAINT IF EXISTS %I', r.conname);
    END IF;
  END LOOP;

  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'game_configs' AND c.contype = 'u'
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.conrelid
        AND a.attnum = ANY (c.conkey)
        AND a.attname = 'gameKey'
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.conrelid
        AND a.attnum = ANY (c.conkey)
        AND a.attname = 'tenant_id'
    ) THEN
      EXECUTE format('ALTER TABLE game_configs DROP CONSTRAINT IF EXISTS %I', r.conname);
    END IF;
  END LOOP;

  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'ledger_events' AND c.contype = 'u'
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.conrelid
        AND a.attnum = ANY (c.conkey)
        AND a.attname IN ('actionId', 'eventType')
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.conrelid
        AND a.attnum = ANY (c.conkey)
        AND a.attname = 'tenant_id'
    ) THEN
      EXECUTE format('ALTER TABLE ledger_events DROP CONSTRAINT IF EXISTS %I', r.conname);
    END IF;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_email_uniq ON users (tenant_id, email);
CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_username_uniq ON users (tenant_id, username);
CREATE UNIQUE INDEX IF NOT EXISTS vouchers_tenant_code_uniq ON vouchers (tenant_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS staff_users_tenant_username_uniq ON staff_users (tenant_id, username);
CREATE UNIQUE INDEX IF NOT EXISTS game_configs_tenant_game_key_uniq ON game_configs (tenant_id, "gameKey");
CREATE UNIQUE INDEX IF NOT EXISTS ledger_events_tenant_action_type_uniq ON ledger_events (tenant_id, "actionId", "eventType");

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'users',
    'wallets',
    'transactions',
    'vouchers',
    'game_rounds',
    'sessions',
    'deposit_intents',
    'withdrawal_intents',
    'ledger_events',
    'session_snapshots',
    'game_configs',
    'api_error_events',
    'support_tickets',
    'player_safety_limits',
    'player_safety_actions',
    'staff_users',
    'staff_keys',
    'staff_messages',
    'staff_push_devices',
    'purchase_orders',
    'purchase_order_messages',
    'tenant_wallets',
    'tenant_voucher_pools',
    'credit_ledger'
  ]) LOOP
    IF to_regclass(tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tbl);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
        tbl
      );
      EXECUTE format('DROP POLICY IF EXISTS owner_override ON %I', tbl);
      EXECUTE format(
        'CREATE POLICY owner_override ON %I USING (current_setting(''app.role'', true) = ''owner'') WITH CHECK (current_setting(''app.role'', true) = ''owner'')',
        tbl
      );
    END IF;
  END LOOP;
END $$;
