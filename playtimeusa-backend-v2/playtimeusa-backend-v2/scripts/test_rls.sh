#!/usr/bin/env bash
set -euo pipefail

COMPOSE="docker compose"
if ! ${COMPOSE} version >/dev/null 2>&1; then
  COMPOSE="docker-compose"
fi

${COMPOSE} -f docker-compose.test.yml up -d
sleep 2

export DATABASE_URL="postgres://playtime:playtime@localhost:5434/playtime_test"
export JWT_ACCESS_SECRET="test-access"
export JWT_REFRESH_SECRET="test-refresh"
export JWT_SECRET="test-admin"
export STAFF_JWT_SECRET="test-staff"
export NODE_ENV="test"

node scripts/migrate.js
node scripts/test_rls.js

${COMPOSE} -f docker-compose.test.yml down -v
