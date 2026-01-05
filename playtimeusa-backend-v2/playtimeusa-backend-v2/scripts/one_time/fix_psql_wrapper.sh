#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

FILE="scripts/db/psql.sh"
TS="$(date +%s)"

if [[ -f "$FILE" ]]; then
  cp "$FILE" "${FILE}.bak.${TS}"
  echo "[backup] ${FILE}.bak.${TS}"
fi

cat > "$FILE" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

# psql wrapper:
# - Uses DATABASE_URL by default (loaded from env or .env)
# - Preserves option ordering by appending the DB URL at the END
# - If caller already specifies a DB (via -d/--dbname or a postgres:// url), we do NOT override.

# Load DATABASE_URL from .env if not already set
if [[ -z "${DATABASE_URL:-}" && -f .env ]]; then
  export DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -n1 | cut -d= -f2-)"
fi

ARGS=("$@")
HAS_DB=0

for ((i=0; i<${#ARGS[@]}; i++)); do
  a="${ARGS[$i]}"

  # explicit db via flags
  if [[ "$a" == "-d" || "$a" == "--dbname" ]]; then HAS_DB=1; break; fi
  if [[ "$a" == -d* && "$a" != "-d" ]]; then HAS_DB=1; break; fi
  if [[ "$a" == --dbname=* ]]; then HAS_DB=1; break; fi

  # explicit db via URL argument
  if [[ "$a" =~ ^postgres(ql)?:// ]]; then HAS_DB=1; break; fi
done

PSQL_BIN="psql"
if [[ -x /usr/bin/psql ]]; then PSQL_BIN="/usr/bin/psql"; fi

# If caller already specified db, just run.
if [[ "$HAS_DB" -eq 1 ]]; then
  exec "$PSQL_BIN" "${ARGS[@]}"
fi

# Otherwise require DATABASE_URL and append it
: "${DATABASE_URL:?DATABASE_URL not set (and not found in .env)}"
export PGSSLMODE="${PGSSLMODE:-require}"

exec "$PSQL_BIN" "${ARGS[@]}" "$DATABASE_URL"
SH

chmod +x "$FILE"
echo "[ok] rewrote $FILE"
