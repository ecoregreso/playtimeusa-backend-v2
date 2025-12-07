#!/usr/bin/env bash
set -e

API_BASE="http://localhost:3000"
ADMIN_EMAIL="admin@example.com"
ADMIN_USERNAME="admin"
ADMIN_PASSWORD="Test1234!"

echo "== PlaytimeUSA :: Dev auth flow =="

echo "[1] Checking backend health at $API_BASE/health ..."
if ! curl -s "$API_BASE/health" >/dev/null; then
  echo "!! Backend not responding on $API_BASE"
  exit 1
fi
echo "   OK: backend is up."

echo
echo "[2] Trying to register admin user (will ignore if already exists)..."

REGISTER_BODY=$(cat <<EOF
{
  "email": "$ADMIN_EMAIL",
  "username": "$ADMIN_USERNAME",
  "password": "$ADMIN_PASSWORD",
  "role": "admin"
}
EOF
)

REGISTER_RESPONSE_FILE=$(mktemp)
REGISTER_STATUS=$(curl -s -o "$REGISTER_RESPONSE_FILE" -w "%{http_code}" \
  -X POST "$API_BASE/auth/register" \
  -H "Content-Type: application/json" \
  -d "$REGISTER_BODY")

if [[ "$REGISTER_STATUS" == "201" ]]; then
  echo "   Created new admin user: $ADMIN_EMAIL / $ADMIN_USERNAME"
elif [[ "$REGISTER_STATUS" == "409" ]]; then
  echo "   Admin already exists, continuing..."
else
  echo "!! Unexpected response from /auth/register (HTTP $REGISTER_STATUS):"
  cat "$REGISTER_RESPONSE_FILE"
  rm -f "$REGISTER_RESPONSE_FILE"
  exit 1
fi

rm -f "$REGISTER_RESPONSE_FILE"

echo
echo "[3] Logging in as admin..."
LOGIN_BODY=$(cat <<EOF
{
  "emailOrUsername": "$ADMIN_USERNAME",
  "password": "$ADMIN_PASSWORD"
}
EOF
)

LOGIN_RESPONSE=$(curl -s \
  -X POST "$API_BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d "$LOGIN_BODY")

ERROR_MSG=$(echo "$LOGIN_RESPONSE" | jq -r '.error // empty')

if [[ -n "$ERROR_MSG" ]]; then
  echo "!! Login failed: $ERROR_MSG"
  echo "Raw response:"
  echo "$LOGIN_RESPONSE"
  exit 1
fi

ACCESS_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.tokens.accessToken')
REFRESH_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.tokens.refreshToken')
ADMIN_ID=$(echo "$LOGIN_RESPONSE" | jq -r '.user.id')

if [[ "$ACCESS_TOKEN" == "null" || -z "$ACCESS_TOKEN" ]]; then
  echo "!! Could not extract accessToken from login response."
  echo "$LOGIN_RESPONSE"
  exit 1
fi

echo "   Login OK. Admin ID: $ADMIN_ID"

echo
echo "[4] Verifying /auth/me with access token..."

ME_RESPONSE=$(curl -s "$API_BASE/auth/me" \
  -H "Authorization: Bearer $ACCESS_TOKEN")

ME_ERROR=$(echo "$ME_RESPONSE" | jq -r '.error // empty')

if [[ -n "$ME_ERROR" ]]; then
  echo "!! /auth/me error: $ME_ERROR"
  echo "Raw response:"
  echo "$ME_RESPONSE"
  exit 1
fi

echo "   /auth/me OK. User summary:"
echo "$ME_RESPONSE" | jq '.user'

echo
echo "== Done =="
echo
echo "Access Token:"
echo "$ACCESS_TOKEN"
echo
echo "Refresh Token:"
echo "$REFRESH_TOKEN"
echo
echo "Tip:"
echo "  export PTU_ADMIN_TOKEN=\"$ACCESS_TOKEN\""
echo "  # Then you can use it like:"
echo "  # curl http://localhost:3000/auth/me -H \"Authorization: Bearer \$PTU_ADMIN_TOKEN\""
