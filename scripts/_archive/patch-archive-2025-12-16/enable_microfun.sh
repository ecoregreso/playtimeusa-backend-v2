#!/usr/bin/env bash
set -euo pipefail

cd ~/Projects/PlayTime-USA/backend

# ---- Prefer system psql (avoid snap confinement permission problems) ----
mkdir -p scripts/db
cat > scripts/db/psql.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ -x /usr/bin/psql ]; then
  exec /usr/bin/psql "$@"
fi
exec psql "$@"
EOF
chmod +x scripts/db/psql.sh

# ---- Replace migrate.sh with schema_migrations-tolerant version ----
cat > scripts/db/migrate.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

PSQL="./scripts/db/psql.sh"

if [ -z "${DATABASE_URL:-}" ]; then
  export DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)"
fi
export PGSSLMODE="${PGSSLMODE:-require}"

echo "DATABASE_URL loaded."
"$PSQL" -v ON_ERROR_STOP=1 -tAc "SELECT 1" >/dev/null

"$PSQL" -v ON_ERROR_STOP=1 -c "
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
"

detect_col() {
  "$PSQL" -tAc "SELECT column_name
               FROM information_schema.columns
               WHERE table_name='schema_migrations'
                 AND column_name IN ('id','filename','name')
               ORDER BY CASE column_name WHEN 'id' THEN 1 WHEN 'filename' THEN 2 ELSE 3 END
               LIMIT 1;"
}

apply_one() {
  local file="$1"
  local mid
  mid="$(basename "$file")"

  local col
  col="$(detect_col)"

  if [ -z "$col" ]; then
    echo "schema_migrations table is incompatible (no id/filename/name). Recreating..."
    "$PSQL" -v ON_ERROR_STOP=1 -c "DROP TABLE IF EXISTS schema_migrations;"
    "$PSQL" -v ON_ERROR_STOP=1 -c "CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());"
    col="id"
  fi

  local already
  already="$("$PSQL" -tAc "SELECT 1 FROM schema_migrations WHERE ${col}='${mid}' LIMIT 1;")"

  if [ "$already" = "1" ]; then
    echo "==> Skipping $mid (already applied)"
    return
  fi

  echo "==> Applying $mid"
  "$PSQL" -v ON_ERROR_STOP=1 -f "$file"
  "$PSQL" -v ON_ERROR_STOP=1 -c "INSERT INTO schema_migrations(${col}) VALUES ('${mid}');"
}

shopt -s nullglob
for f in migrations/*.sql; do
  apply_one "$f"
done

echo "Migrations complete."
EOF
chmod +x scripts/db/migrate.sh

# ---- Ensure the microFUN migration exists (4 decimals => 1 FUN = 10,000 microFUN) ----
mkdir -p migrations
cat > migrations/002_fun_micro_bigint.sql <<'EOF'
DO $$
DECLARE
  scale bigint := 10000;
  dt text;
BEGIN
  -- wallets.balance
  SELECT data_type INTO dt FROM information_schema.columns WHERE table_name='wallets' AND column_name='balance';
  IF dt IS NOT NULL AND dt <> 'bigint' THEN
    EXECUTE format('ALTER TABLE wallets ALTER COLUMN balance TYPE bigint USING round(balance * %s)::bigint', scale);
  END IF;

  -- transactions.amount
  SELECT data_type INTO dt FROM information_schema.columns WHERE table_name='transactions' AND column_name='amount';
  IF dt IS NOT NULL AND dt <> 'bigint' THEN
    EXECUTE format('ALTER TABLE transactions ALTER COLUMN amount TYPE bigint USING round(amount * %s)::bigint', scale);
  END IF;

  -- transactions.balanceBefore
  SELECT data_type INTO dt FROM information_schema.columns WHERE table_name='transactions' AND column_name='balanceBefore';
  IF dt IS NOT NULL AND dt <> 'bigint' THEN
    EXECUTE format('ALTER TABLE transactions ALTER COLUMN "balanceBefore" TYPE bigint USING round("balanceBefore" * %s)::bigint', scale);
  END IF;

  -- transactions.balanceAfter
  SELECT data_type INTO dt FROM information_schema.columns WHERE table_name='transactions' AND column_name='balanceAfter';
  IF dt IS NOT NULL AND dt <> 'bigint' THEN
    EXECUTE format('ALTER TABLE transactions ALTER COLUMN "balanceAfter" TYPE bigint USING round("balanceAfter" * %s)::bigint', scale);
  END IF;

  -- deposit_intents amount_fun
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='deposit_intents' AND column_name='amount_fun') THEN
    SELECT data_type INTO dt FROM information_schema.columns WHERE table_name='deposit_intents' AND column_name='amount_fun';
    IF dt <> 'bigint' THEN
      EXECUTE format('ALTER TABLE deposit_intents ALTER COLUMN amount_fun TYPE bigint USING round(amount_fun * %s)::bigint', scale);
    END IF;
  END IF;

  -- withdrawal_intents amount_fun
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='withdrawal_intents' AND column_name='amount_fun') THEN
    SELECT data_type INTO dt FROM information_schema.columns WHERE table_name='withdrawal_intents' AND column_name='amount_fun';
    IF dt <> 'bigint' THEN
      EXECUTE format('ALTER TABLE withdrawal_intents ALTER COLUMN amount_fun TYPE bigint USING round(amount_fun * %s)::bigint', scale);
    END IF;
  END IF;
END $$;
EOF

echo "== Running migrations (system psql wrapper) =="
./scripts/db/migrate.sh

echo
echo "DONE. If your server is running, restart it with:"
echo "  DB_SYNC=0 npm run dev"
