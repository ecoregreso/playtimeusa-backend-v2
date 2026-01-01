DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'enum_staff_users_role'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'enum_staff_users_role'
        AND e.enumlabel = 'distributor'
    ) THEN
      ALTER TYPE enum_staff_users_role ADD VALUE 'distributor';
    END IF;
  END IF;
END $$;
