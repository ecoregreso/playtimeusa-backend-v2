#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
AMOUNT="${1:-100}"
BONUS="${2:-50}"

SESSION_DIR=".session"
ADMIN_TOKEN_FILE="${SESSION_DIR}/admin_token"

log() {
  echo
  echo "== $1 =="
}

require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq is required. Install it with: sudo apt install jq"
    exit 1
  fi
}

load_admin_token() {
  # 1) Try cached token file from daemon
  if [ -f "$ADMIN_TOKEN_FILE" ]; then
    PTU_ADMIN_TOKEN="$(tr -d '\r\n' < "$ADMIN_TOKEN_FILE")"
    if [ -n "$PTU_ADMIN_TOKEN" ]; then
      export PTU_ADMIN_TOKEN
      echo "Using cached admin token from ${ADMIN_TOKEN_FILE}"
      return 0
    fi
  fi

  # 2) Fallback: call dev-auth-flow.sh once
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
load_admin_token

log "Creating voucher (amount=${AMOUNT}, bonus=${BONUS})"

RES="$(
  curl -sS -X POST "${BASE_URL}/vouchers" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${PTU_ADMIN_TOKEN}" \
    -d "{
      \"amount\": ${AMOUNT},
      \"bonusAmount\": ${BONUS}
    }"
)"

ERROR_MSG="$(echo "$RES" | jq -r '.error // empty')"
if [ -n "$ERROR_MSG" ]; then
  echo "ERROR from backend: $ERROR_MSG"
  echo "Raw response:"
  echo "$RES"
  exit 1
fi

V_ID="$(echo "$RES"       | jq -r '.voucher.id // empty')"
V_CODE="$(echo "$RES"     | jq -r '.voucher.code // empty')"
V_PIN="$(echo "$RES"      | jq -r '.pin // empty')"
V_USERCODE="$(echo "$RES" | jq -r '.userCode // .voucher.metadata.userCode // empty')"
V_AMOUNT="$(echo "$RES"   | jq -r '.voucher.amount // empty')"
V_BONUS="$(echo "$RES"    | jq -r '.voucher.bonusAmount // empty')"
V_QR_PATH="$(echo "$RES"  | jq -r '.qr.path // empty')"

log "Voucher created"

echo "  ID:         ${V_ID}"
echo "  CODE:       ${V_CODE}"
echo "  USER CODE:  ${V_USERCODE}"
echo "  PIN:        ${V_PIN}"
echo "  AMOUNT:     ${V_AMOUNT}"
echo "  BONUS:      ${V_BONUS}"
echo "  QR PNG:     ${V_QR_PATH}"

echo
echo "Hand this to the player:"
echo "  User Code: ${V_USERCODE}"
echo "  PIN:       ${V_PIN}"

echo
echo "Raw JSON response (for debugging):"
echo "$RES"
