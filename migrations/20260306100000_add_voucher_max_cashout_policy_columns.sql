-- RLS-aware backfill: ensure migrations run with owner context.
SELECT set_config('app.role', 'owner', false);
SELECT set_config('app.user_id', 'migration', false);
SELECT set_config('app.tenant_id', '', false);

ALTER TABLE IF EXISTS vouchers
  ADD COLUMN IF NOT EXISTS max_cashout NUMERIC(18, 4);

ALTER TABLE IF EXISTS wallets
  ADD COLUMN IF NOT EXISTS active_voucher_id UUID;

CREATE INDEX IF NOT EXISTS wallets_active_voucher_idx
  ON wallets (active_voucher_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'vouchers'
      AND column_name = 'totalCredit'
  ) THEN
    EXECUTE '
      UPDATE vouchers
      SET max_cashout = COALESCE(
        max_cashout,
        NULLIF("totalCredit", 0),
        NULLIF(COALESCE(amount, 0) + COALESCE("bonusAmount", 0), 0)
      )
      WHERE max_cashout IS NULL
    ';
  ELSIF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'vouchers'
      AND column_name = 'total_credit'
  ) THEN
    EXECUTE '
      UPDATE vouchers
      SET max_cashout = COALESCE(
        max_cashout,
        NULLIF(total_credit, 0),
        NULLIF(COALESCE(amount, 0) + COALESCE(bonus_amount, 0), 0)
      )
      WHERE max_cashout IS NULL
    ';
  ELSE
    EXECUTE '
      UPDATE vouchers
      SET max_cashout = COALESCE(
        max_cashout,
        NULLIF(COALESCE(amount, 0), 0)
      )
      WHERE max_cashout IS NULL
    ';
  END IF;
END $$;

UPDATE vouchers
SET max_cashout = 0
WHERE max_cashout IS NULL;

ALTER TABLE IF EXISTS vouchers
  ALTER COLUMN max_cashout SET DEFAULT 0;

ALTER TABLE IF EXISTS vouchers
  ALTER COLUMN max_cashout SET NOT NULL;
