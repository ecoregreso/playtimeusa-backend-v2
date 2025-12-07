// scripts/seed-staff-permissions.js
require("dotenv").config();
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

/**
 * Central role → permissions mapping.
 * Adjust this as the platform grows.
 */
const ROLE_PERMISSIONS = {
  // Full god-mode: everything
  owner: [
    "tenant:manage",
    "staff:manage",
    "player:read",
    "player:write",
    "finance:read",
    "finance:write",
    "voucher:read",
    "voucher:write",
    "betlog:read",
    "system:config",
  ],

  // Operator: almost everything except low-level system config
  operator: [
    "tenant:manage",
    "staff:manage",
    "player:read",
    "player:write",
    "finance:read",
    "finance:write",
    "voucher:read",
    "voucher:write",
    "betlog:read",
  ],

  // Cashier: front-line wallet & voucher handling
  cashier: [
    "player:read",
    "finance:read",
    "finance:write",
    "voucher:read",
    "voucher:write",
  ],

  // Agent: can manage their own downline / players, limited finance
  agent: [
    "player:read",
    "player:write",
    "finance:read",
    "voucher:read",
  ],

  // Support: mainly viewing, auditing
  support: [
    "player:read",
    "voucher:read",
    "betlog:read",
  ],
};

async function main() {
  console.log("== PlaytimeUSA :: Seed staff permissions by role ==");
  try {
    await sequelize.authenticate();
    console.log("[DB] Connected");

    // Fetch all staff users
    const [rows] = await sequelize.query(
      'SELECT id, username, role, "isActive", permissions FROM staff_users ORDER BY id ASC'
    );

    if (!rows || rows.length === 0) {
      console.log("[INFO] No staff users found in staff_users table.");
      return;
    }

    console.log(`[INFO] Found ${rows.length} staff user(s).`);

    let updatedCount = 0;

    for (const row of rows) {
      const role = row.role;
      const username = row.username;
      const currentPerms = row.permissions;
      const targetPerms = ROLE_PERMISSIONS[role];

      if (!targetPerms) {
        console.log(
          `[SKIP] staff_users.id=${row.id} username="${username}" role="${role}" has no ROLE_PERMISSIONS mapping.`
        );
        continue;
      }

      // If permissions already match exactly, skip
      let alreadySame = false;
      try {
        const parsed =
          currentPerms && typeof currentPerms === "string"
            ? JSON.parse(currentPerms)
            : currentPerms;

        if (Array.isArray(parsed)) {
          // naive equality check: same length & every perm in ROLE_PERMISSIONS
          if (
            parsed.length === targetPerms.length &&
            parsed.every((p) => targetPerms.includes(p))
          ) {
            alreadySame = true;
          }
        }
      } catch {
        // ignore parse errors, we'll overwrite
      }

      if (alreadySame) {
        console.log(
          `[SKIP] staff_users.id=${row.id} username="${username}" role="${role}" already has matching permissions.`
        );
        continue;
      }

      // Update permissions
      const [updatedRows] = await sequelize.query(
        'UPDATE staff_users SET permissions = $2::jsonb, "updatedAt" = NOW() WHERE id = $1 RETURNING id, username, role, permissions',
        {
          bind: [row.id, JSON.stringify(targetPerms)],
        }
      );

      const updatedRow = updatedRows[0];
      updatedCount++;
      console.log(
        `[UPDATE] staff_users.id=${updatedRow.id} username="${updatedRow.username}" role="${updatedRow.role}" -> permissions set to [${targetPerms.join(
          ", "
        )}]`
      );
    }

    console.log("");
    console.log(
      `[DONE] Permissions seeding finished. Updated ${updatedCount} staff user(s).`
    );
  } catch (err) {
    console.error("[ERROR] seed-staff-permissions failed:", err);
    process.exit(1);
  } finally {
    await sequelize.close().catch(() => {});
  }
}

main();
