#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"

log() {
  echo
  echo "== $1 =="
}

# 1) ALWAYS get a fresh admin token via dev-auth-flow.sh
log "Obtaining fresh admin token via dev-auth-flow.sh..."

if [ ! -x "./scripts/dev-auth-flow.sh" ]; then
  echo "ERROR: scripts/dev-auth-flow.sh is missing or not executable."
  exit 1
fi

PTU_ADMIN_TOKEN="$(
  ./scripts/dev-auth-flow.sh | awk '
    /Access Token:/ {getline; gsub(/\r/,""); print; exit}
  '
)"

if [ -z "$PTU_ADMIN_TOKEN" ]; then
  echo "ERROR: Could not parse admin access token from dev-auth-flow.sh."
  exit 1
fi

export PTU_ADMIN_TOKEN
echo "Admin token (PTU_ADMIN_TOKEN) is set."

# 2) Ensure jq is available (for parsing JSON)
if ! command -v jq >/dev/null 2>&1; then
  echo
  echo "WARNING: jq not installed. Install it with: sudo apt install jq"
  echo "This script needs jq to parse JSON responses."
  exit 1
fi

# 3) Login or create player1
log "Logging in as player1 (or creating if missing)..."

LOGIN_RES="$(
  curl -sS -X POST "${BASE_URL}/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"emailOrUsername":"player1","password":"Player123!"}'
)"

LOGIN_OK="$(echo "$LOGIN_RES" | jq -r '.user.id // empty')"

if [ -z "$LOGIN_OK" ]; then
  log "player1 not found or login failed. Trying to register player1..."

  REG_RES="$(
    curl -sS -X POST "${BASE_URL}/auth/register" \
      -H "Content-Type: application/json" \
      -d '{
        "email": "player1@example.com",
        "username": "player1",
        "password": "Player123!",
        "role": "player"
      }'
  )"

  PLAYER_ID="$(echo "$REG_RES" | jq -r '.user.id // empty')"
  PTU_PLAYER_TOKEN="$(echo "$REG_RES" | jq -r '.tokens.accessToken // empty')"

  if [ -z "$PLAYER_ID" ] || [ -z "$PTU_PLAYER_TOKEN" ]; then
    echo "ERROR: Failed to register player1:"
    echo "$REG_RES"
    exit 1
  fi
else
  PLAYER_ID="$LOGIN_OK"
  PTU_PLAYER_TOKEN="$(echo "$LOGIN_RES" | jq -r '.tokens.accessToken // empty')"
fi

export PTU_PLAYER_TOKEN

log "Session summary"
echo "  Admin token:   PTU_ADMIN_TOKEN (exported)"
echo "  Player token:  PTU_PLAYER_TOKEN (exported)"
echo "  Player1 ID:    ${PLAYER_ID}"

echo
echo "Example usage now that tokens are set:"
echo "  curl http://localhost:3000/auth/me -H \"Authorization: Bearer \$PTU_ADMIN_TOKEN\""
echo "  curl http://localhost:3000/vouchers -H \"Authorization: Bearer \$PTU_ADMIN_TOKEN\""
echo "  curl http://localhost:3000/auth/me -H \"Authorization: Bearer \$PTU_PLAYER_TOKEN\""

echo
echo "== Done =="
