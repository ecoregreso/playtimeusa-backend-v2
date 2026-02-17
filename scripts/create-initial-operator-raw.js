// scripts/create-initial-operator-raw.js
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { Sequelize } = require("sequelize");
const crypto = require("crypto");

// Use DATABASE_URL directly instead of going through src/models
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("[DB] Missing env DATABASE_URL");
  process.exit(1);
}

const sequelize = new Sequelize(databaseUrl, {
  dialect: "postgres",
  logging: process.env.DB_LOGGING === "true" ? console.log : false,
  dialectOptions: {
    ssl: process.env.PGSSLMODE
      ? { require: true, rejectUnauthorized: false }
      : false,
  },
});

async function main() {
  const email = process.env.INIT_STAFF_EMAIL || "owner@example.com";
  const password = process.env.INIT_STAFF_PASSWORD || "Owner123!";
  const displayName = process.env.INIT_STAFF_NAME || "Platform Owner";
  const role = "operator";

  // Default permission set for operator. Adjust if your schema expects something else.
  const defaultPermissions = [
    "tenant:manage",
    "staff:manage",
    "player:read",
    "player:write",
    "finance:read",
    "finance:write",
    "betlog:read",
  ];

  console.log("== PlaytimeUSA :: RAW create initial operator staff user ==");
  console.log(`Email: ${email}`);
  console.log(`Role:  ${role}`);
  console.log("");

  try {
    await sequelize.authenticate();
    console.log("[DB] Connected");

    // 1) Check if staff user already exists
    const [existingRows] = await sequelize.query(
      `SELECT id, email, "role", "permissions"
       FROM staff_users
       WHERE email = $1
       LIMIT 1`,
      {
        bind: [email.toLowerCase()],
      }
    );

    if (existingRows && existingRows.length > 0) {
      console.log(
        `[INFO] Staff user with email ${email} already exists. Skipping create.`
      );
      console.log(existingRows[0]);
      process.exit(0);
    }

    // 2) Hash password
    const hash = await bcrypt.hash(password, 10);

    // 3) Ensure default tenant
    let tenantId = null;
    const [tenantRows] = await sequelize.query(
      "SELECT id FROM tenants WHERE name = $1 LIMIT 1",
      { bind: ["Default"] }
    );
    if (tenantRows && tenantRows.length > 0) {
      tenantId = tenantRows[0].id;
    } else {
      const [createdRows] = await sequelize.query(
        "INSERT INTO tenants (name, status, external_id, \"createdAt\", \"updatedAt\") VALUES ($1, 'active', $2, NOW(), NOW()) RETURNING id",
        { bind: ["Default", crypto.randomUUID()] }
      );
      tenantId = createdRows[0].id;
    }

    // 4) Insert new staff user
    const [insertRows] = await sequelize.query(
      `INSERT INTO staff_users
        (tenant_id, email, "passwordHash", "displayName", "role", "permissions", "isActive", "createdAt", "updatedAt")
       VALUES
        ($1, $2, $3, $4, $5, $6::jsonb, true, NOW(), NOW())
       RETURNING id, email, "displayName", "role", "permissions", "isActive"`,
      {
        bind: [
          tenantId,
          email.toLowerCase(),
          hash,
          displayName,
          role,
          JSON.stringify(defaultPermissions),
        ],
      }
    );

    const staff = insertRows[0];

    console.log("[OK] Created staff user (raw SQL):");
    console.log(staff);
    console.log("");
    console.log("You can now log in with:");
    console.log(`  email:    ${email}`);
    console.log(`  password: ${password}`);
  } catch (err) {
    console.error("[ERROR] Failed to create initial operator (raw):", err);
    process.exit(1);
  } finally {
    await sequelize.close().catch(() => {});
  }
}

main();
