-- Create shift_closures table for cashier shift reconciliation
CREATE TABLE IF NOT EXISTS shift_closures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  summary jsonb,
  checklist jsonb,
  notes text,
  expected_balance numeric(18,4),
  actual_balance numeric(18,4),
  closed_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shift_closures_tenant_staff ON shift_closures(tenant_id, staff_id, start_at);

ALTER TABLE shift_closures ENABLE ROW LEVEL SECURITY;

CREATE POLICY shift_closures_tenant_policy ON shift_closures
USING (
  (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  OR (coalesce(current_setting('app.role', true), '') = 'owner')
)
WITH CHECK (
  (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  OR (coalesce(current_setting('app.role', true), '') = 'owner')
);
