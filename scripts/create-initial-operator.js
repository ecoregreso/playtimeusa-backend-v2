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
  const username = process.env.INIT_STAFF_USERNAME || "owner";
  const password = process.env.INIT_STAFF_PASSWORD || "Owner123!";
  const role = process.env.INIT_STAFF_ROLE || "operator";

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
  console.log("Username: " + username);
  console.log("Role:     " + role);
  console.log("");

  try {
    await sequelize.authenticate();
    console.log("[DB] Connected");

    // 1) Check if username exists
    const [existingRows] = await sequelize.query(
      'SELECT id, username, role, "isActive", permissions FROM staff_users WHERE username = $1 LIMIT 1',
      { bind: [username] }
    );

    if (existingRows && existingRows.length > 0) {
      console.log(
        '[INFO] Staff user with username "' +
          username +
          '" already exists. Skipping create.'
      );
      console.log(existingRows[0]);
      process.exit(0);
    }

    // 2) Hash password
    const hash = await bcrypt.hash(password, 10);

    // 3) Insert staff user via raw SQL
    const [insertRows] = await sequelize.query(
      `INSERT INTO staff_users
        (username, "passwordHash", role, "agentCode", "parentId", "isActive", permissions, "createdAt", "updatedAt")
       VALUES
        ($1, $2, $3, NULL, NULL, true, $4::jsonb, NOW(), NOW())
       RETURNING id, username, role, "isActive", permissions`,
      {
        bind: [username, hash, role, JSON.stringify(defaultPermissions)],
      }
    );

    const staff = insertRows[0];

    console.log("[OK] Created staff user (RAW SQL):");
    console.log(staff);
    console.log("");
    console.log("You can now log in with:");
    console.log("  username: " + username);
    console.log("  password: " + password);
  } catch (err) {
    console.error("[ERROR] create-initial-operator RAW failed:", err);
    process.exit(1);
  } finally {
    await sequelize.close().catch(() => {});
  }
}

main();
