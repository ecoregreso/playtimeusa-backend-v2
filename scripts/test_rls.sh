#!/usr/bin/env bash
set -euo pipefail

COMPOSE="docker compose"
if ! ${COMPOSE} version >/dev/null 2>&1; then
  COMPOSE="docker-compose"
fi

cleanup() {
  ${COMPOSE} -f docker-compose.test.yml down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Ensure a clean test database state before starting.
cleanup
${COMPOSE} -f docker-compose.test.yml up -d

echo "[test:rls] waiting for postgres..."
ready=0
for i in {1..30}; do
  if ${COMPOSE} -f docker-compose.test.yml exec -T postgres pg_isready -U playtime -d playtime_test >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [ "${ready}" -ne 1 ]; then
  echo "[test:rls] postgres did not become ready in time"
  exit 1
fi

export DATABASE_URL="postgres://playtime:playtime@localhost:5434/playtime_test"
export PGSSLMODE="disable"
export JWT_ACCESS_SECRET="test-access"
export JWT_REFRESH_SECRET="test-refresh"
export JWT_SECRET="test-admin"
export STAFF_JWT_SECRET="test-staff"
export NODE_ENV="test"

# Bootstrap/migrations require elevated privileges.
export DATABASE_URL="postgres://playtime:playtime@localhost:5434/playtime_test"
node scripts/bootstrap.js

# Run RLS checks using a non-superuser role (superusers bypass RLS).
${COMPOSE} -f docker-compose.test.yml exec -T postgres psql -U playtime -d playtime_test <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'playtime_app') THEN
    CREATE ROLE playtime_app LOGIN PASSWORD 'playtime_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
  ELSE
    ALTER ROLE playtime_app WITH LOGIN PASSWORD 'playtime_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;
  END IF;
END $$;
GRANT CONNECT ON DATABASE playtime_test TO playtime_app;
GRANT USAGE ON SCHEMA public TO playtime_app;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO playtime_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO playtime_app;
SQL

export DATABASE_URL="postgres://playtime_app:playtime_app@localhost:5434/playtime_test"
node scripts/test_rls.js
