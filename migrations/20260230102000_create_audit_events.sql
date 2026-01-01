CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NULL,
  "eventType" VARCHAR(64) NOT NULL,
  success BOOLEAN NOT NULL DEFAULT true,
  "requestId" VARCHAR(64),
  "actorType" VARCHAR(32),
  "actorId" VARCHAR(128),
  "actorRole" VARCHAR(64),
  "actorUsername" VARCHAR(128),
  route VARCHAR(255),
  method VARCHAR(16),
  "statusCode" INTEGER,
  ip VARCHAR(64),
  "userAgent" TEXT,
  meta JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_events_tenant_idx ON audit_events (tenant_id);
CREATE INDEX IF NOT EXISTS audit_events_type_idx ON audit_events ("eventType");
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events ("createdAt");
CREATE INDEX IF NOT EXISTS audit_events_request_idx ON audit_events ("requestId");

ALTER TABLE audit_events
  ALTER COLUMN tenant_id SET DEFAULT (current_setting('app.tenant_id', true))::uuid;

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_events_tenant_isolation ON audit_events;
CREATE POLICY audit_events_tenant_isolation ON audit_events
  USING (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    OR (tenant_id IS NULL AND current_setting('app.tenant_id', true) IS NULL)
    OR current_setting('app.role', true) = 'owner'
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)::uuid
    OR (tenant_id IS NULL AND current_setting('app.tenant_id', true) IS NULL)
    OR current_setting('app.role', true) = 'owner'
  );
