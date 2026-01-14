#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3000}"

echo "[smoke_api] GET /api/health"
health_resp=$(curl -s "${API_BASE}/api/health")
if echo "$health_resp" | grep -q "Cannot GET"; then
  echo "[smoke_api] /api/health returned a route error"
  echo "$health_resp"
  exit 1
fi
if ! echo "$health_resp" | grep -q '"ok"'; then
  echo "[smoke_api] /api/health missing ok field"
  echo "$health_resp"
  exit 1
fi

echo "[smoke_api] POST /api/v1/staff/login (expect 400/401, not 404)"
resp_file=$(mktemp)
status=$(curl -s -o "$resp_file" -w "%{http_code}" \
  -X POST "${API_BASE}/api/v1/staff/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"x","password":"y"}')

if [ "$status" = "404" ]; then
  echo "[smoke_api] staff login returned 404"
  cat "$resp_file"
  rm -f "$resp_file"
  exit 1
fi

if [ "$status" != "400" ] && [ "$status" != "401" ]; then
  echo "[smoke_api] staff login returned unexpected status: $status"
  cat "$resp_file"
  rm -f "$resp_file"
  exit 1
fi

rm -f "$resp_file"

echo "[smoke_api] ok"
