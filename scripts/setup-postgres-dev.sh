#!/usr/bin/env bash
set -euo pipefail

echo "=== PlaytimeUSA Postgres Dev Setup ==="

# 1) Move to project root (one level up from scripts/)
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "Project root: $PROJECT_ROOT"

# 2) Basic sanity check
if [ ! -f "package.json" ]; then
  echo "ERROR: package.json not found in $PROJECT_ROOT"
  echo "Run this script from inside the backend repo (where package.json lives)."
  exit 1
fi

# 3) Remove sqlite3 from deps if present
echo "-> Ensuring sqlite3 is NOT installed or referenced..."
if npm list sqlite3 >/dev/null 2>&1; then
  npm uninstall sqlite3 || true
else
  echo "sqlite3 not found in node_modules. Good."
fi

# 4) Install Node dependencies
echo "-> Installing npm dependencies..."
npm install

# 5) Create .env if missing (Postgres-only)
if [ ! -f ".env" ]; then
  echo "-> .env not found. Creating a new Postgres dev .env..."

  DB_NAME_DEFAULT="playtimeusa"
  DB_USER_DEFAULT="playtime"
  DB_PASS_RANDOM="$(openssl rand -hex 12 2>/dev/null || echo "PlaytimeDevPass123!")"
  JWT_SECRET_RANDOM="$(openssl rand -hex 32 2>/dev/null || echo "CHANGE_ME_JWT_SECRET")"

  cat > .env <<EOF
# Server
PORT=3000
FRONTEND_URL=http://localhost:4173

# JWT
JWT_SECRET=${JWT_SECRET_RANDOM}

# Local Postgres config
DB_NAME=${DB_NAME_DEFAULT}
DB_USER=${DB_USER_DEFAULT}
DB_PASS=${DB_PASS_RANDOM}
DB_HOST=127.0.0.1
DB_PORT=5432
DB_SSL=false

# Optional: if you want to use DATABASE_URL instead of DB_* vars, set it below
# DATABASE_URL=postgres://${DB_USER_DEFAULT}:${DB_PASS_RANDOM}@127.0.0.1:5432/${DB_NAME_DEFAULT}
EOF

  echo "-> .env created with:"
  echo "   DB_NAME=${DB_NAME_DEFAULT}"
  echo "   DB_USER=${DB_USER_DEFAULT}"
  echo "   DB_PASS=<randomly generated>"
else
  echo "-> .env already exists. Using existing Postgres settings."
fi

# 6) Load .env into this shell
set -a
source ./.env
set +a

# 7) Ensure Postgres is installed
if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql (Postgres client) not found."
  echo "Install Postgres on Ubuntu with:"
  echo "  sudo apt update && sudo apt install postgresql postgresql-contrib"
  exit 1
fi

# 8) Create Postgres user + DB if not exists (idempotent)
echo "-> Creating Postgres user/database if needed..."

sudo -u postgres psql <<SQL
DO \$\$
BEGIN
   IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
      CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';
   END IF;
END\$\$;

DO \$\$
BEGIN
   IF NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}') THEN
      CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};
   END IF;
END\$\$;

GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
SQL

echo "-> Postgres user/database ready:"
echo "   DB_HOST=${DB_HOST}"
echo "   DB_PORT=${DB_PORT}"
echo "   DB_NAME=${DB_NAME}"
echo "   DB_USER=${DB_USER}"

# 9) Ensure Postgres-only Sequelize config
mkdir -p config

if [ ! -f "config/database.js" ]; then
  echo "-> config/database.js not found. Creating Postgres-only config..."

  cat > config/database.js << 'EOF'
const { Sequelize } = require('sequelize');

let sequelize;

// Prefer DATABASE_URL if provided (great for cloud)
if (process.env.DATABASE_URL) {
  sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: 'postgres',
    logging: false,
    dialectOptions: process.env.DB_SSL === 'true'
      ? {
          ssl: {
            require: true,
            rejectUnauthorized: false
          }
        }
      : {}
  });
  console.log('[DB] Using Postgres via DATABASE_URL');
} else {
  // Fallback to individual DB_* environment variables (local dev)
  const dbName = process.env.DB_NAME;
  const dbUser = process.env.DB_USER;
  const dbPass = process.env.DB_PASS;
  const dbHost = process.env.DB_HOST || '127.0.0.1';
  const dbPort = process.env.DB_PORT || 5432;

  if (!dbName || !dbUser) {
    throw new Error('Missing DB_NAME or DB_USER in environment variables');
  }

  sequelize = new Sequelize(dbName, dbUser, dbPass, {
    host: dbHost,
    port: dbPort,
    dialect: 'postgres',
    logging: false
  });
  console.log(`[DB] Using Postgres at ${dbHost}:${dbPort}/${dbName}`);
}

module.exports = sequelize;
EOF

else
  echo "-> config/database.js already exists. NOT overwriting. Make sure it's Postgres-only."
fi

echo
echo "=== Setup complete ==="
echo "Now start your dev server with:"
echo "  cd \"$PROJECT_ROOT\""
echo "  npm run dev"
