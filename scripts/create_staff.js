const path = require("path");
require("dotenv").config({ path: path.join(process.cwd(), ".env") });

const bcrypt = require("bcryptjs");
const { sequelize, StaffUser } = require("../src/models");

const [, , usernameArg, passwordArg, roleArg] = process.argv;
const username = usernameArg ? String(usernameArg).trim() : "";
const password = passwordArg ? String(passwordArg) : "";
const role = roleArg ? String(roleArg).trim() : "owner";

const allowedRoles = new Set(["owner", "operator", "agent", "distributor", "cashier"]);

if (!process.env.DATABASE_URL) {
  console.error("[staff:create] DATABASE_URL is required");
  process.exit(1);
}

if (!username || !password) {
  console.error("Usage: node scripts/create_staff.js <username> <password> [role]");
  process.exit(1);
}

if (!allowedRoles.has(role)) {
  console.error(
    `[staff:create] Invalid role "${role}". Allowed: ${Array.from(allowedRoles).join(", ")}`
  );
  process.exit(1);
}

async function main() {
  await sequelize.authenticate();

  let created = null;
  let existing = null;

  await sequelize.transaction(async (t) => {
    await sequelize.query("SET LOCAL app.role = 'owner'", { transaction: t });
    await sequelize.query("SET LOCAL app.user_id = 'staff:create'", { transaction: t });
    await sequelize.query("SET LOCAL app.tenant_id = ''", { transaction: t });

    existing = await StaffUser.findOne({ where: { username }, transaction: t });
    if (existing) return;

    const passwordHash = await bcrypt.hash(password, 12);

    created = await StaffUser.create(
      {
        username,
        passwordHash,
        role,
        tenantId: null,
        distributorId: null,
        email: null,
        agentCode: null,
        parentId: null,
        isActive: true,
        permissions: null,
      },
      { transaction: t }
    );
  });

  if (existing) {
    console.log(
      `[staff:create] Staff user already exists for username "${username}" (id=${existing.id})`
    );
    return;
  }

  console.log("[staff:create] Created staff user:");
  console.log({ id: created.id, username: created.username, role: created.role });
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error("[staff:create] failed:", err.message || err);
      process.exit(1);
    })
    .finally(async () => {
      await sequelize.close().catch(() => {});
    });
}

module.exports = { main };
