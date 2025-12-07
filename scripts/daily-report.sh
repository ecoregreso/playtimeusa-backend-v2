#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
DAY="${1:-$(date +%Y-%m-%d)}"  # default today

SESSION_DIR=".session"
ADMIN_TOKEN_FILE="${SESSION_DIR}/admin_token"

log() {
  echo
  echo "== $1 =="
}

require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq is required. Install it with: sudo apt install jq"
    echo "Hint: sudo apt install jq"
    exit 1
  fi
}

load_admin_token() {
  if [ -f "$ADMIN_TOKEN_FILE" ]; then
    PTU_ADMIN_TOKEN="$(tr -d '\r\n' < "$ADMIN_TOKEN_FILE")"
    if [ -n "$PTU_ADMIN_TOKEN" ]; then
      export PTU_ADMIN_TOKEN
      echo "Using cached admin token from ${ADMIN_TOKEN_FILE}"
      return 0
    fi
  fi

  echo "No cached admin token found. Calling dev-auth-flow.sh..."

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
    echo "ERROR: Could not parse admin token from dev-auth-flow.sh"
    exit 1
  fi

  mkdir -p "$SESSION_DIR"
  echo "$PTU_ADMIN_TOKEN" > "$ADMIN_TOKEN_FILE"
  export PTU_ADMIN_TOKEN
  echo "Refreshed admin token and saved to ${ADMIN_TOKEN_FILE}"
}

require_jq
mkdir -p exports

log "Running SOFTSWISS-grade daily report for: ${DAY}"

load_admin_token

REPORT_JSON="$(
  curl -sS "${BASE_URL}/admin/reports/daily?day=${DAY}" \
    -H "Authorization: Bearer ${PTU_ADMIN_TOKEN}" \
    -H "Accept: application/json"
)"

ERROR_MSG="$(echo "$REPORT_JSON" | jq -r '.error // empty')"
if [ -n "$ERROR_MSG" ]; then
  echo "ERROR from backend: $ERROR_MSG"
  echo "Raw response:"
  echo "$REPORT_JSON"
  exit 1
fi

OUT_FILE="exports/daily_report_${DAY}.json"
echo "$REPORT_JSON" > "$OUT_FILE"

NEW_PLAYERS="$(echo "$REPORT_JSON" | jq '.players.new')"
ACTIVE_PLAYERS="$(echo "$REPORT_JSON" | jq '.players.active')"

ISSUED_COUNT="$(echo "$REPORT_JSON" | jq '.vouchers.issued.count')"
ISSUED_AMT="$(echo "$REPORT_JSON" | jq '.vouchers.issued.totalAmount')"
ISSUED_BONUS="$(echo "$REPORT_JSON" | jq '.vouchers.issued.totalBonus')"

REDEEMED_COUNT="$(echo "$REPORT_JSON" | jq '.vouchers.redeemed.count')"
REDEEMED_AMT="$(echo "$REPORT_JSON" | jq '.vouchers.redeemed.totalAmount')"
REDEEMED_BONUS="$(echo "$REPORT_JSON" | jq '.vouchers.redeemed.totalBonus')"
REDEEMED_PLAYERS="$(echo "$REPORT_JSON" | jq '.vouchers.redeemed.uniquePlayers')"

GAME_BET_TOTAL="$(echo "$REPORT_JSON" | jq '.transactions.aggregates.gameBetTotal')"
GAME_WIN_TOTAL="$(echo "$REPORT_JSON" | jq '.transactions.aggregates.gameWinTotal')"
GAME_NET="$(echo "$REPORT_JSON" | jq '.transactions.aggregates.netGame')"

TOTAL_ROUNDS="$(echo "$REPORT_JSON" | jq '.games.totalRounds')"
TOTAL_GGR="$(echo "$REPORT_JSON" | jq '.games.ggr')"

log "Daily Operator Report :: ${DAY}"

echo "Players:"
echo "  New players:      ${NEW_PLAYERS}"
echo "  Active players:   ${ACTIVE_PLAYERS}"

echo
echo "Vouchers:"
echo "  Issued:           ${ISSUED_COUNT}"
echo "    Total amount:   ${ISSUED_AMT}"
echo "    Total bonus:    ${ISSUED_BONUS}"
echo "  Redeemed:         ${REDEEMED_COUNT}"
echo "    Total amount:   ${REDEEMED_AMT}"
echo "    Total bonus:    ${REDEEMED_BONUS}"
echo "    Unique players: ${REDEEMED_PLAYERS}"

echo
echo "Games (from transactions + rounds):"
echo "  Bet total:        ${GAME_BET_TOTAL}"
echo "  Win total:        ${GAME_WIN_TOTAL}"
echo "  Net game (GGR):   ${GAME_NET}"
echo "  Rounds (GameRound): ${TOTAL_ROUNDS}"
echo "  GGR (GameRound):  ${TOTAL_GGR}"

echo
echo "Full JSON report saved to: ${OUT_FILE}"
echo
echo "Examples:"
echo "  cat ${OUT_FILE} | jq '.transactions.byType'"
echo "  cat ${OUT_FILE} | jq '.games.byGame[0]'"
