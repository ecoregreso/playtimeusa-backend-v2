#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"

# Args: count, amount, bonus
COUNT="${1:-10}"
AMOUNT="${2:-100}"
BONUS="${3:-50}"

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
load_admin_token

timestamp="$(date +%Y%m%d_%H%M%S)"
OUT_DIR="exports"
mkdir -p "$OUT_DIR"

CSV_FILE="${OUT_DIR}/vouchers_${COUNT}x_${AMOUNT}_${BONUS}_${timestamp}.csv"

log "Writing batch to: ${CSV_FILE}"

echo "index,voucher_id,code,user_code,pin,amount,bonus,currency,created_at,qr_path" > "$CSV_FILE"

for ((i=1; i<=COUNT; i++)); do
  log "Creating voucher ${i}/${COUNT} (amount=${AMOUNT}, bonus=${BONUS})"

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
    echo "ERROR from backend on voucher ${i}: $ERROR_MSG"
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
  V_CURRENCY="$(echo "$RES" | jq -r '.voucher.currency // "FUN"')"
  V_CREATED_AT="$(echo "$RES" | jq -r '.voucher.createdAt // empty')"
  V_QR_PATH="$(echo "$RES"  | jq -r '.qr.path // empty')"

  if [ -z "$V_CODE" ] || [ -z "$V_PIN" ]; then
    echo "ERROR: Missing code or pin in response for voucher ${i}."
    echo "$RES"
    exit 1
  fi`

  echo "  -> CODE=${V_CODE} | USER_CODE=${V_USERCODE} | PIN=${V_PIN} | AMOUNT=${V_AMOUNT} | BONUS=${V_BONUS} | QR=${V_QR_PATH}"

  printf '%s,"%s","%s","%s","%s",%s,%s,"%s","%s","%s"\n' \
    "$i" "$V_ID" "$V_CODE" "$V_USERCODE" "$V_PIN" "$V_AMOUNT" "$V_BONUS" "$V_CURRENCY" "$V_CREATED_AT" "$V_QR_PATH" \
    >> "$CSV_FILE"
done

log "Batch complete."
echo "Created ${COUNT} vouchers."
echo "CSV saved to: ${CSV_FILE}"

echo
echo "Sample line format:"
echo "index,voucher_id,code,user_code,pin,amount,bonus,currency,created_at,qr_path"
