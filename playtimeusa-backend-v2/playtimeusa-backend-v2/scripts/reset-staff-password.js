// scripts/reset-staff-password.js
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { Sequelize } = require("sequelize");

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("[DB] Missing env DATABASE_URL");
  process.exit(1);
}

console.log(
  "[DB] Using Postgres via DATABASE_URL",
  process.env.PGSSLMODE ? "(SSL enabled)" : "(no SSL)"
);

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
  const username = process.env.RESET_STAFF_USERNAME || "owner";
  const newPassword = process.env.RESET_STAFF_PASSWORD || "Owner123!";

  console.log("== PlaytimeUSA :: Reset staff password ==");
  console.log("Username: " + username);
  console.log("");

  try {
    await sequelize.authenticate();
    console.log("[DB] Connected");

    // Check that the user exists
    const [existingRows] = await sequelize.query(
      'SELECT id, username, role, "isActive" FROM staff_users WHERE username = $1 LIMIT 1',
      { bind: [username] }
    );

    if (!existingRows || existingRows.length === 0) {
      console.error('[ERROR] No staff user found with username "' + username + '"');
      process.exit(1);
    }

    const hash = await bcrypt.hash(newPassword, 10);

    const [updatedRows] = await sequelize.query(
      'UPDATE staff_users SET "passwordHash" = $2, "updatedAt" = NOW() WHERE username = $1 RETURNING id, username, role, "isActive"',
      { bind: [username, hash] }
    );

    const row = updatedRows[0];
    console.log("[OK] Updated staff password for:");
    console.log(row);
    console.log("");
    console.log("New credentials:");
    console.log("  username: " + username);
    console.log("  password: " + newPassword);
  } catch (err) {
    console.error("[ERROR] reset-staff-password failed:", err);
    process.exit(1);
  } finally {
    await sequelize.close().catch(() => {});
  }
}

main();
