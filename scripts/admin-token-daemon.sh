#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
SESSION_DIR=".session"
ADMIN_TOKEN_FILE="${SESSION_DIR}/admin_token"

log() {
  echo
  echo "== $1 =="
}

if [ ! -x "./scripts/dev-auth-flow.sh" ]; then
  echo "ERROR: scripts/dev-auth-flow.sh is missing or not executable."
  exit 1
fi

mkdir -p "$SESSION_DIR"

log "Starting admin token daemon. Tokens will be stored in ${ADMIN_TOKEN_FILE}"
echo "Press Ctrl+C to stop."

while true; do
  echo
  echo "-- Refreshing admin token at $(date -Is) --"

  PTU_ADMIN_TOKEN="$(
    ./scripts/dev-auth-flow.sh | awk '
      /Access Token:/ {getline; gsub(/\r/,""); print; exit}
    '
  )"

  if [ -z "$PTU_ADMIN_TOKEN" ]; then
    echo "  [ERROR] Could not parse Access Token from dev-auth-flow.sh output."
  else
    echo "$PTU_ADMIN_TOKEN" > "$ADMIN_TOKEN_FILE"
    echo "  [OK] Admin token refreshed and written to ${ADMIN_TOKEN_FILE}"
  fi

  # Refresh every 10 minutes. Your token TTL is shorter, so this is safe.
  sleep 600
done

