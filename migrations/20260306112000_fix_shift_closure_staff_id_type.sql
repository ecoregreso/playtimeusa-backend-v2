-- Align shift_closures.staff_id with staff_users.id (INTEGER)
DO $$
BEGIN
  IF to_regclass('shift_closures') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shift_closures'
      AND column_name = 'staff_id'
      AND udt_name = 'uuid'
  ) THEN
    ALTER TABLE shift_closures ALTER COLUMN staff_id DROP NOT NULL;

    ALTER TABLE shift_closures
      ALTER COLUMN staff_id TYPE INTEGER
      USING (
        CASE
          WHEN staff_id::text ~ '^[0-9]+$' THEN staff_id::text::integer
          ELSE NULL
        END
      );

    DELETE FROM shift_closures WHERE staff_id IS NULL;

    ALTER TABLE shift_closures ALTER COLUMN staff_id SET NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shift_closures_tenant_staff ON shift_closures (tenant_id, staff_id, start_at);
