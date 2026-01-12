#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3000}"
OWNER_TOKEN="${OWNER_TOKEN:-}"
TENANT_TOKEN="${TENANT_TOKEN:-}"
USERNAME="${SECURITY_TEST_USERNAME:-smoke_test_user}"
PASSWORD="${SECURITY_TEST_PASSWORD:-wrong-password}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required"
  exit 1
fi

echo "[smoke] triggering failed staff logins..."
for i in {1..10}; do
  curl -s -o /dev/null -X POST "${API_BASE}/api/v1/staff/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}" || true
  sleep 0.2
done

echo "[smoke] attempting owner endpoint as tenant (if token provided)..."
if [[ -n "${TENANT_TOKEN}" ]]; then
  curl -s -o /dev/null -w "tenant status: %{http_code}\n" \
    -H "Authorization: Bearer ${TENANT_TOKEN}" \
    "${API_BASE}/api/v1/owner/security/summary" || true
else
  echo "TENANT_TOKEN not set, skipping tenant access violation check"
fi

echo "[smoke] checking alerts (owner token required)..."
if [[ -z "${OWNER_TOKEN}" ]]; then
  echo "OWNER_TOKEN not set; cannot verify alerts via owner endpoint"
  exit 0
fi

curl -s -H "Authorization: Bearer ${OWNER_TOKEN}" \
  "${API_BASE}/api/v1/owner/security/alerts?status=open&limit=5"

echo "\n[smoke] done"
