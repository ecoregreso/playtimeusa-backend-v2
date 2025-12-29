const fs = require("fs");
const path = require("path");
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
  await client.query(sql);
  await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
}

async function runMigrations() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
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
