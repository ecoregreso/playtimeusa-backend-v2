#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <player-query>"
  echo "Example: $0 player1"
  exit 1
fi

PLAYER_QUERY="$1"

log() {
  echo
  echo "== $1 =="
}

# 1) Get admin token if not already exported
if [ "${PTU_ADMIN_TOKEN:-}" = "" ]; then
  log "No PTU_ADMIN_TOKEN found. Running dev-auth-flow.sh to obtain one..."
  if [ ! -x "./scripts/dev-auth-flow.sh" ]; then
    echo "ERROR: scripts/dev-auth-flow.sh is missing or not executable."
    exit 1
  fi

  # Capture Access Token line from the script output
  PTU_ADMIN_TOKEN="$(
    ./scripts/dev-auth-flow.sh | awk '
      /Access Token:/ {getline; gsub(/\r/,""); print; exit}
    '
  )"

  if [ -z "$PTU_ADMIN_TOKEN" ]; then
    echo "ERROR: Failed to parse Access Token from dev-auth-flow.sh output."
    exit 1
  fi

  export PTU_ADMIN_TOKEN
  echo "Got admin token."
else
  log "Using existing PTU_ADMIN_TOKEN from environment."
fi

# 2) Hit /admin/players/search
log "Searching for player with query: \"$PLAYER_QUERY\""

SEARCH_JSON="$(
  curl -sS "${BASE_URL}/admin/players/search?q=${PLAYER_QUERY}" \
    -H "Authorization: Bearer ${PTU_ADMIN_TOKEN}" \
    -H "Accept: application/json"
)"

echo "Search response:"
echo "$SEARCH_JSON"

# 3) Try to extract first player's id using jq if available
if command -v jq >/dev/null 2>&1; then
  PLAYER_ID="$(echo "$SEARCH_JSON" | jq -r '.[0].id // empty')"
else
  PLAYER_ID=""
  echo
  echo "Note: jq is not installed. Cannot auto-extract player ID."
  echo "Install it with: sudo apt install jq"
fi

if [ -z "${PLAYER_ID}" ]; then
  echo
  echo "Could not determine PLAYER_ID from search results."
  echo "If jq is installed, make sure the search returned at least one player."
  exit 0
fi

echo
echo "Using PLAYER_ID: ${PLAYER_ID}"

# 4) Fetch wallets
log "Fetching wallets for PLAYER_ID=${PLAYER_ID}"

curl -sS "${BASE_URL}/admin/players/${PLAYER_ID}/wallets" \
  -H "Authorization: Bearer ${PTU_ADMIN_TOKEN}" \
  -H "Accept: application/json"

# 5) Fetch transactions
log "Fetching last 50 transactions for PLAYER_ID=${PLAYER_ID}"

curl -sS "${BASE_URL}/admin/players/${PLAYER_ID}/transactions?limit=50" \
  -H "Authorization: Bearer ${PTU_ADMIN_TOKEN}" \
  -H "Accept: application/json"

# 6) Fetch game rounds
log "Fetching last 50 game rounds for PLAYER_ID=${PLAYER_ID}"

curl -sS "${BASE_URL}/admin/players/${PLAYER_ID}/game-rounds?limit=50" \
  -H "Authorization: Bearer ${PTU_ADMIN_TOKEN}" \
  -H "Accept: application/json"

echo
echo "== Done =="
