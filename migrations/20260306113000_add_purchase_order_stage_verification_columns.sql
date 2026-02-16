ALTER TABLE IF EXISTS purchase_orders
  ADD COLUMN IF NOT EXISTS owner_approved_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS payment_confirmed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS payment_wallet_provider VARCHAR(32) NULL,
  ADD COLUMN IF NOT EXISTS credited_amount_cents BIGINT NULL,
  ADD COLUMN IF NOT EXISTS receipt_code VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS receipt_issued_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_status
  ON purchase_orders (status);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_payment_wallet_provider
  ON purchase_orders (payment_wallet_provider);
