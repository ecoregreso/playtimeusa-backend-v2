#!/usr/bin/env bash
set -euo pipefail

echo "=== PlaytimeUSA Backend Bootstrap (Staff + DB) ==="

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "Project root: $PROJECT_ROOT"

if [ ! -f ".env" ]; then
  echo "ERROR: .env not found in $PROJECT_ROOT"
  echo "Create .env with DATABASE_URL, JWT_SECRET, etc. first."
  exit 1
fi

echo "-> Installing npm dependencies..."
npm install

echo "-> Running DB sync + staff seeding..."
NODE_ENV=development node scripts/sync-db-and-seed-staff.js

echo "=== Done. You should now have:"
echo " - DB schema synced"
echo " - At least one owner account"
echo
echo "Check logs above for the exact usernames/passwords seeded."
