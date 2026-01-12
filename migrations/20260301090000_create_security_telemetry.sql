-- Security telemetry + audit log tables (idempotent)
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid') THEN
    EXECUTE $ddl$
      CREATE TABLE IF NOT EXISTS security_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        ts timestamptz NOT NULL DEFAULT now(),
        tenant_id uuid NULL,
        actor_type text NOT NULL,
        actor_id uuid NULL,
        ip inet NULL,
        user_agent text NULL,
        method text NULL,
        path text NULL,
        request_id uuid NULL,
        event_type text NOT NULL,
        severity smallint NOT NULL DEFAULT 1,
        details jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    $ddl$;
    EXECUTE $ddl$
      CREATE TABLE IF NOT EXISTS audit_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        ts timestamptz NOT NULL DEFAULT now(),
        tenant_id uuid NULL,
        actor_type text NOT NULL,
        actor_id uuid NULL,
        action text NOT NULL,
        entity_type text NULL,
        entity_id uuid NULL,
        before jsonb NULL,
        after jsonb NULL,
        request_id uuid NULL,
        prev_hash text NULL,
        hash text NOT NULL
      )
    $ddl$;
    EXECUTE $ddl$
      CREATE TABLE IF NOT EXISTS security_alerts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        ts timestamptz NOT NULL DEFAULT now(),
        tenant_id uuid NULL,
        severity smallint NOT NULL,
        rule_id text NOT NULL,
        title text NOT NULL,
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        status text NOT NULL DEFAULT 'open',
        acknowledged_by uuid NULL,
        acknowledged_at timestamptz NULL,
        closed_by uuid NULL,
        closed_at timestamptz NULL
      )
    $ddl$;
  ELSE
    EXECUTE $ddl$
      CREATE TABLE IF NOT EXISTS security_events (
        id uuid PRIMARY KEY,
        ts timestamptz NOT NULL DEFAULT now(),
        tenant_id uuid NULL,
        actor_type text NOT NULL,
        actor_id uuid NULL,
        ip inet NULL,
        user_agent text NULL,
        method text NULL,
        path text NULL,
        request_id uuid NULL,
        event_type text NOT NULL,
        severity smallint NOT NULL DEFAULT 1,
        details jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    $ddl$;
    EXECUTE $ddl$
      CREATE TABLE IF NOT EXISTS audit_log (
        id uuid PRIMARY KEY,
        ts timestamptz NOT NULL DEFAULT now(),
        tenant_id uuid NULL,
        actor_type text NOT NULL,
        actor_id uuid NULL,
        action text NOT NULL,
        entity_type text NULL,
        entity_id uuid NULL,
        before jsonb NULL,
        after jsonb NULL,
        request_id uuid NULL,
        prev_hash text NULL,
        hash text NOT NULL
      )
    $ddl$;
    EXECUTE $ddl$
      CREATE TABLE IF NOT EXISTS security_alerts (
        id uuid PRIMARY KEY,
        ts timestamptz NOT NULL DEFAULT now(),
        tenant_id uuid NULL,
        severity smallint NOT NULL,
        rule_id text NOT NULL,
        title text NOT NULL,
        details jsonb NOT NULL DEFAULT '{}'::jsonb,
        status text NOT NULL DEFAULT 'open',
        acknowledged_by uuid NULL,
        acknowledged_at timestamptz NULL,
        closed_by uuid NULL,
        closed_at timestamptz NULL
      )
    $ddl$;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS security_events_ts_idx ON security_events (ts DESC);
CREATE INDEX IF NOT EXISTS security_events_tenant_ts_idx ON security_events (tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS security_events_type_ts_idx ON security_events (event_type, ts DESC);
CREATE INDEX IF NOT EXISTS security_events_ip_ts_idx ON security_events (ip, ts DESC);

CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_tenant_ts_idx ON audit_log (tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_ts_idx ON audit_log (action, ts DESC);

CREATE INDEX IF NOT EXISTS security_alerts_status_ts_idx ON security_alerts (status, ts DESC);
CREATE INDEX IF NOT EXISTS security_alerts_tenant_status_ts_idx ON security_alerts (tenant_id, status, ts DESC);
CREATE INDEX IF NOT EXISTS security_alerts_rule_ts_idx ON security_alerts (rule_id, ts DESC);
