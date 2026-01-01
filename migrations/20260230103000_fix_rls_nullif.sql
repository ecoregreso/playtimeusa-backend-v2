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
    'credit_ledger',
    'players',
    'bets',
    'bonuses',
    'ledger_entries'
  ]) LOOP
    IF to_regclass(tbl) IS NOT NULL THEN
      BEGIN
        EXECUTE format(
          'ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid',
          tbl
        );
      EXCEPTION WHEN undefined_column THEN
        NULL;
      END;

      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', tbl);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
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

DO $$
BEGIN
  IF to_regclass('audit_events') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE audit_events ALTER COLUMN tenant_id SET DEFAULT NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid';
    EXECUTE 'ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE audit_events FORCE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS audit_events_tenant_isolation ON audit_events';
    EXECUTE '
      CREATE POLICY audit_events_tenant_isolation ON audit_events
        USING (
          tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid
          OR (tenant_id IS NULL AND NULLIF(current_setting(''app.tenant_id'', true), '''') IS NULL)
          OR current_setting(''app.role'', true) = ''owner''
        )
        WITH CHECK (
          tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid
          OR (tenant_id IS NULL AND NULLIF(current_setting(''app.tenant_id'', true), '''') IS NULL)
          OR current_setting(''app.role'', true) = ''owner''
        )
    ';
  END IF;
END $$;
