const path = require('path');
require('dotenv').config({ path: path.join(process.cwd(), '.env') });

const fs = require("fs");
const { Client } = require("pg");

async function ensureSchemaTable(client) {
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
  );
}

async function getApplied(client) {
  const res = await client.query("SELECT id FROM schema_migrations");
  return new Set(res.rows.map((row) => row.id));
}

async function applyMigration(client, id, sql) {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function runMigrations() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const sslRequired = String(process.env.PGSSLMODE||"").toLowerCase()==="require";
  const client = new Client({ connectionString, ssl: sslRequired ? { rejectUnauthorized: false } : undefined });
  await client.connect();

  try {
    // Migrations must bypass tenant RLS policies to touch existing rows safely.
    await client.query("SELECT set_config('app.role', 'owner', false)");
    await client.query("SELECT set_config('app.user_id', 'migration', false)");
    await client.query("SELECT set_config('app.tenant_id', '', false)");

    await ensureSchemaTable(client);
    const applied = await getApplied(client);

    const migrationsDir = path.join(__dirname, "..", "migrations");
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      console.log(`[migrate] applying ${file}`);
      await applyMigration(client, file, sql);
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log("[migrate] done");
    })
    .catch((err) => {
      console.error("[migrate] failed:", err.message || err);
      process.exit(1);
    });
}

module.exports = { runMigrations };
