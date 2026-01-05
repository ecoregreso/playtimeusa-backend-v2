DROP INDEX IF EXISTS ledger_events_action_event_unique;

DO $$
BEGIN
  IF to_regclass('staff_users') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE staff_users ALTER COLUMN tenant_id DROP NOT NULL';
  END IF;
END $$;

DO $$
DECLARE
  default_tenant UUID;
  table_name TEXT;
BEGIN
  SELECT id INTO default_tenant FROM tenants WHERE name = 'Default' LIMIT 1;
  IF default_tenant IS NULL THEN
    INSERT INTO tenants (name, status) VALUES ('Default', 'active') RETURNING id INTO default_tenant;
  END IF;

  FOR table_name IN SELECT unnest(ARRAY[
    'players',
    'bets',
    'bonuses',
    'ledger_entries'
  ]) LOOP
    IF to_regclass(table_name) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id UUID', table_name);
      EXECUTE format('UPDATE %I SET tenant_id = $1 WHERE tenant_id IS NULL', table_name) USING default_tenant;
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid',
        table_name
      );
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
END $$;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'players',
    'bets',
    'bonuses',
    'ledger_entries'
  ]) LOOP
    IF to_regclass(tbl) IS NOT NULL THEN
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
