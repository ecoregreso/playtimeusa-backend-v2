#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"

if [ $# -lt 2 ]; then
  echo "Usage: $0 <start-yyyy-mm-dd> <end-yyyy-mm-dd>"
  echo "Example: $0 2025-12-01 2025-12-07"
  exit 1
fi

START_DAY="$1"
END_DAY="$2"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required. Install it with: sudo apt install jq"
  echo "Hint: sudo apt install jq"
  exit 1
fi

mkdir -p exports

log() {
  echo
  echo "== $1 =="
}

log "Running range report: ${START_DAY} .. ${END_DAY}"

# Always bootstrap for fresh admin token
if [ ! -x "./scripts/dev-bootstrap-session.sh" ]; then
  echo "ERROR: scripts/dev-bootstrap-session.sh is missing or not executable."
  exit 1
fi

./scripts/dev-bootstrap-session.sh

REPORT_JSON="$(
  curl -sS "${BASE_URL}/admin/reports/range?start=${START_DAY}&end=${END_DAY}" \
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

OUT_FILE="exports/range_report_${START_DAY}_to_${END_DAY}.json"
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

log "Range Operator Report :: ${START_DAY} .. ${END_DAY}"

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
echo "Games:"
echo "  Bet total:        ${GAME_BET_TOTAL}"
echo "  Win total:        ${GAME_WIN_TOTAL}"
echo "  Net game (GGR):   ${GAME_NET}"
echo "  Rounds:           ${TOTAL_ROUNDS}"
echo "  GGR (GameRound):  ${TOTAL_GGR}"

echo
echo "Full JSON report saved to: ${OUT_FILE}"
echo
echo "Examples:"
echo "  cat ${OUT_FILE} | jq '.transactions.byType'"
echo "  cat ${OUT_FILE} | jq '.games.byGame[0]'"
