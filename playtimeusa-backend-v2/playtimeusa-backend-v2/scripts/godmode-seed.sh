#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"

PLAYER_PASSWORD="Player123!"
ADMIN_LIKE_PASSWORD="Admin123!"
NUM_PLAYERS="${1:-20}"  # default 20 sample players

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

# Ensure we have fresh admin token and player1 seeded
bootstrap_session() {
  if [ ! -x "./scripts/dev-bootstrap-session.sh" ]; then
    echo "ERROR: scripts/dev-bootstrap-session.sh is missing or not executable."
    exit 1
  fi

  log "Bootstrapping session (fresh admin + player1)..."
  ./scripts/dev-bootstrap-session.sh
}

# Create an "admin-like" account (for future cashiers/ops). Role is admin for now.
create_admin_like_user() {
  local username="$1"
  local email="$2"
  local password="$3"

  log "Ensuring admin-like user exists: ${username}"

  # Try login first
  local login_res user_id
  login_res="$(
    curl -sS -X POST "${BASE_URL}/auth/login" \
      -H "Content-Type: application/json" \
      -d "{\"emailOrUsername\":\"${username}\",\"password\":\"${password}\"}"
  )"

  user_id="$(echo "$login_res" | jq -r '.user.id // empty')"

  if [ -n "$user_id" ]; then
    echo "  -> ${username} already exists (id=${user_id})"
    return 0
  fi

  # Try register
  local reg_res
  reg_res="$(
    curl -sS -X POST "${BASE_URL}/auth/register" \
      -H "Content-Type: application/json" \
      -d "{
        \"email\": \"${email}\",
        \"username\": \"${username}\",
        \"password\": \"${password}\",
        \"role\": \"admin\"
      }"
  )"

  user_id="$(echo "$reg_res" | jq -r '.user.id // empty')"

  if [ -n "$user_id" ]; then
    echo "  -> Created admin-like user ${username} (id=${user_id})"
  else
    echo "  -> WARNING: Failed to create ${username}. Raw response:"
    echo "$reg_res"
  fi
}

# Ensure player exists and return "id|token"
ensure_player_with_token() {
  local username="$1"
  local email="$2"
  local password="$3"

  local login_res user_id token reg_res

  # Try login
  login_res="$(
    curl -sS -X POST "${BASE_URL}/auth/login" \
      -H "Content-Type: application/json" \
      -d "{\"emailOrUsername\":\"${username}\",\"password\":\"${password}\"}"
  )"

  user_id="$(echo "$login_res" | jq -r '.user.id // empty')"
  token="$(echo "$login_res" | jq -r '.tokens.accessToken // empty')"

  if [ -n "$user_id" ] && [ -n "$token" ]; then
    echo "${user_id}|${token}"
    return 0
  fi

  # Register if login failed
  reg_res="$(
    curl -sS -X POST "${BASE_URL}/auth/register" \
      -H "Content-Type: application/json" \
      -d "{
        \"email\": \"${email}\",
        \"username\": \"${username}\",
        \"password\": \"${password}\",
        \"role\": \"player\"
      }"
  )"

  user_id="$(echo "$reg_res" | jq -r '.user.id // empty')"

  if [ -z "$user_id" ]; then
    echo "ERROR: Failed to register player ${username}."
    echo "$reg_res"
    exit 1
  fi

  # Fresh login after register
  login_res="$(
    curl -sS -X POST "${BASE_URL}/auth/login" \
      -H "Content-Type: application/json" \
      -d "{\"emailOrUsername\":\"${username}\",\"password\":\"${password}\"}"
  )"

  user_id="$(echo "$login_res" | jq -r '.user.id // empty')"
  token="$(echo "$login_res" | jq -r '.tokens.accessToken // empty')"

  if [ -z "$user_id" ] || [ -z "$token" ]; then
    echo "ERROR: Could not log in newly created player ${username}."
    echo "$login_res"
    exit 1
  fi

  echo "${user_id}|${token}"
}

# Create a voucher via admin token, return "code|pin"
create_voucher_for_seed() {
  local amount="$1"
  local bonus="$2"

  local res error v_code v_pin

  res="$(
    curl -sS -X POST "${BASE_URL}/vouchers" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${PTU_ADMIN_TOKEN}" \
      -d "{
        \"amount\": ${amount},
        \"bonusAmount\": ${bonus}
      }"
  )"

  error="$(echo "$res" | jq -r '.error // empty')"
  if [ -n "$error" ]; then
    echo "ERROR: Failed to create voucher for seed: ${error}"
    echo "$res"
    exit 1
  fi

  v_code="$(echo "$res" | jq -r '.voucher.code // empty')"
  v_pin="$(echo "$res" | jq -r '.pin // empty')"

  if [ -z "$v_code" ] || [ -z "$v_pin" ]; then
    echo "ERROR: Voucher response missing code or pin:"
    echo "$res"
    exit 1
  fi

  echo "${v_code}|${v_pin}"
}

# Redeem voucher as player (best effort)
redeem_voucher_as_player() {
  local code="$1"
  local pin="$2"
  local player_token="$3"

  local res error

  res="$(
    curl -sS -X POST "${BASE_URL}/vouchers/redeem" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${player_token}" \
      -d "{
        \"code\": \"${code}\",
        \"pin\": \"${pin}\"
      }"
  )"

  error="$(echo "$res" | jq -r '.error // empty')"
  if [ -n "$error" ]; then
    echo "  -> Redeem failed (probably fine for seeding): ${error}"
    echo "     Raw: $res"
  else
    echo "  -> Redeemed voucher for player. Wallet + transaction created."
  fi
}

# Optional: manual adjustment on player's wallet
manual_adjust_wallet_for_player() {
  local player_id="$1"
  local amount="$2"

  # Get wallets for that player
  local wallets_json wallet_id

  wallets_json="$(
    curl -sS "${BASE_URL}/admin/players/${player_id}/wallets" \
      -H "Authorization: Bearer ${PTU_ADMIN_TOKEN}" \
      -H "Accept: application/json"
  )"

  wallet_id="$(echo "$wallets_json" | jq -r '.[0].id // empty')"

  if [ -z "$wallet_id" ]; then
    echo "  -> No wallet found for player ${player_id}, skipping manual adjustment."
    return 0
  fi

  local res error

  res="$(
    curl -sS -X POST "${BASE_URL}/wallets/${wallet_id}/credit" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${PTU_ADMIN_TOKEN}" \
      -d "{
        \"amount\": ${amount},
        \"type\": \"manual_adjustment\",
        \"reference\": \"godmode-seed-adjustment\",
        \"metadata\": { \"seed\": \"godmode\" }
      }"
  )"

  error="$(echo "$res" | jq -r '.error // empty')"

  if [ -n "$error" ]; then
    echo "  -> Manual adjustment failed for wallet ${wallet_id}: ${error}"
    echo "     Raw: $res"
  else
    echo "  -> Manual adjustment of ${amount} applied to wallet ${wallet_id}."
  fi
}

########################################
# MAIN
########################################

log "Starting GOD MODE environment seed"
require_jq
bootstrap_session

echo
echo "Admin token in env: PTU_ADMIN_TOKEN set"
echo "Player1 token in env: PTU_PLAYER_TOKEN set"

# 1) Ensure some admin-like accounts (future owner/cashiers/etc.)
create_admin_like_user "admin2" "admin2@example.com" "${ADMIN_LIKE_PASSWORD}"
create_admin_like_user "cashier1" "cashier1@example.com" "${ADMIN_LIKE_PASSWORD}"
create_admin_like_user "cashier2" "cashier2@example.com" "${ADMIN_LIKE_PASSWORD}"

# 2) Seed players
log "Seeding ${NUM_PLAYERS} players with vouchers & wallet activity"

# We already have player1 from dev-bootstrap-session. We'll seed player2..N
for i in $(seq 1 "${NUM_PLAYERS}"); do
  username="player${i}"
  email="player${i}@example.com"

  echo
  echo "-- Player seed: ${username} --"

  # Ensure player exists and get token
  result="$(ensure_player_with_token "${username}" "${email}" "${PLAYER_PASSWORD}")"
  player_id="${result%%|*}"
  player_token="${result#*|}"

  echo "  -> Player id: ${player_id}"

  # Decide voucher amount/bonus
  case $((RANDOM % 3)) in
    0)
      voucher_amount=50
      voucher_bonus=25
      ;;
    1)
      voucher_amount=100
      voucher_bonus=50
      ;;
    *)
      voucher_amount=200
      voucher_bonus=100
      ;;
  esac

  echo "  -> Creating voucher amount=${voucher_amount}, bonus=${voucher_bonus}"

  v_res="$(create_voucher_for_seed "${voucher_amount}" "${voucher_bonus}")"
  v_code="${v_res%%|*}"
  v_pin="${v_res#*|}"

  echo "  -> Voucher CODE=${v_code}, PIN=${v_pin}"

  # Randomly decide whether to redeem (simulate breakage)
  redeem_roll=$((RANDOM % 100))
  if [ "$redeem_roll" -lt 75 ]; then
    echo "  -> Redeeming voucher for ${username} (75% chance hit: ${redeem_roll})"
    redeem_voucher_as_player "${v_code}" "${v_pin}" "${player_token}"
  else
    echo "  -> Leaving voucher UNREDEEMED for ${username} (breakage, roll=${redeem_roll})"
  fi

  # Randomly do manual adjustment
  adjust_roll=$((RANDOM % 100))
  if [ "$adjust_roll" -lt 40 ]; then
    adj_amount=$(( (RANDOM % 100) + 10 ))  # 10..109
    echo "  -> Applying manual adjustment of ${adj_amount} to ${username} (roll=${adjust_roll})"
    manual_adjust_wallet_for_player "${player_id}" "${adj_amount}"
  else
    echo "  -> No manual adjustment for ${username} (roll=${adjust_roll})"
  fi
done

log "GOD MODE seed complete."

echo
echo "You now have:"
echo "  - Multiple admin-like accounts (admin2, cashier1, cashier2)"
echo "  - ${NUM_PLAYERS} players (player1..player${NUM_PLAYERS})"
echo "  - Mixed redeemed/unredeemed vouchers"
echo "  - Wallets with voucher_credit + manual_adjustment transactions"
echo
echo "Run your reports to see the chaos:"
echo "  ./scripts/daily-report.sh"
echo "  ./scripts/weekly-report.sh"
echo "  ./scripts/monthly-report.sh"
