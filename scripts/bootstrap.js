// scripts/bootstrap.js
// Safe startup bootstrap:
// - ensures Sequelize tables exist for a fresh DB
// - applies SQL migrations (idempotent)
// - does NOT create staff users by default

require("dotenv").config();

const bcrypt = require("bcryptjs");
const { sequelize, StaffUser } = require("../src/models");
const { runMigrations } = require("./migrate");

async function toRegclass(name) {
  const [rows] = await sequelize.query(
    "SELECT to_regclass(:name) AS reg",
    { replacements: { name } }
  );
  return rows?.[0]?.reg || null;
}

async function ensureBaseTables() {
  // Migrations assume these tables exist (indexes are created outside DO blocks).
  const critical = [
    "users",
    "wallets",
    "transactions",
    "vouchers",
    "game_rounds",
    "sessions",
    "deposit_intents",
    "withdrawal_intents",
    "ledger_events",
    "session_snapshots",
    "game_configs",
    "api_error_events",
    "support_tickets",
    "player_safety_limits",
    "player_safety_actions",
    "staff_users",
    "staff_keys",
    "staff_messages",
    "staff_push_devices",
    "purchase_orders",
    "purchase_order_messages",
  ];

  const checks = await Promise.all(critical.map((t) => toRegclass(t)));
  const missing = critical.filter((t, idx) => !checks[idx]);

  if (!missing.length) {
    console.log("[bootstrap] base tables present.");
    return;
  }

  console.log(`[bootstrap] missing base tables: ${missing.join(", ")}`);
  console.log("[bootstrap] running sequelize.sync() to create missing tables...");

  // Non-destructive: creates missing tables; does NOT alter existing columns.
  await sequelize.sync();

  console.log("[bootstrap] sequelize.sync() done.");
}

async function ensureOwnerAccount() {
  const username = String(process.env.OWNER_USERNAME || "owner").trim();
  const providedPassword = process.env.OWNER_PASSWORD ? String(process.env.OWNER_PASSWORD) : null;

  // If you don't provide OWNER_PASSWORD, we generate one and print it ONCE to logs.
  // (For a demo environment this is fine. For a real deployment, set OWNER_PASSWORD.)
  const password = providedPassword || require("crypto").randomBytes(12).toString("base64url");
  const passwordHash = await bcrypt.hash(password, 12);

  // RLS is enabled on staff_users, so read+write must happen in a transaction
  // with app.role='owner' set.
  let created = false;

  await sequelize.transaction(async (t) => {
    await sequelize.query("SET LOCAL app.role = 'owner'", { transaction: t });
    await sequelize.query("SET LOCAL app.user_id = 'bootstrap'", { transaction: t });
    await sequelize.query("SET LOCAL app.tenant_id = ''", { transaction: t });

    const existing = await StaffUser.findOne({ where: { role: "owner" }, transaction: t });
    if (existing) {
      console.log(`[bootstrap] owner account exists: ${existing.username}`);
      return;
    }

    await StaffUser.create(
      {
        tenantId: null,
        distributorId: null,
        username,
        email: null,
        passwordHash,
        role: "owner",
        isActive: true,
        permissions: null,
      },
      { transaction: t }
    );

    created = true;
  });

  if (!created) return;

  console.log("[bootstrap] CREATED OWNER ACCOUNT");
  console.log(`  username: ${username}`);
  console.log(`  password: ${password}`);
  if (!providedPassword) {
    console.log("[bootstrap] NOTE: set OWNER_PASSWORD in your environment to control this value.");
  }
}

async function main() {
  console.log("[bootstrap] starting...");
  await sequelize.authenticate();
  await ensureBaseTables();
  await runMigrations();
  if (process.env.BOOTSTRAP_OWNER === "true") {
    await ensureOwnerAccount();
  } else {
    console.log("[bootstrap] skipping owner account creation (set BOOTSTRAP_OWNER=true to enable)");
  }
  await sequelize.close();
  console.log("[bootstrap] done.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[bootstrap] failed:", err?.message || err);
    process.exit(1);
  });
}

module.exports = { ensureBaseTables, ensureOwnerAccount };
