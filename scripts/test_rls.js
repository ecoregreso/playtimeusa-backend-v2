const assert = require("assert");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const { sequelize } = require("../src/db");
const {
  Tenant,
  StaffUser,
  User,
  Wallet,
  Voucher,
} = require("../src/models");

const STAFF_JWT_SECRET = process.env.STAFF_JWT_SECRET || "test-staff";

async function withOwnerContext(fn) {
  return sequelize.transaction(async (t) => {
    await sequelize.query("SET LOCAL app.role = 'owner'", { transaction: t });
    await sequelize.query("SET LOCAL app.user_id = 'owner-test'", { transaction: t });
    await sequelize.query("SET LOCAL app.tenant_id = NULL", { transaction: t });
    return fn(t);
  });
}

async function run() {
  const app = require("../src/server");

  const tenantA = await withOwnerContext(() =>
    Tenant.create({ name: "Tenant A", status: "active", externalId: "tenant-a" })
  );
  const tenantB = await withOwnerContext(() =>
    Tenant.create({ name: "Tenant B", status: "active", externalId: "tenant-b" })
  );

  const passwordHash = await bcrypt.hash("test-pass", 10);

  const staffA = await withOwnerContext((t) =>
    StaffUser.create(
      {
        tenantId: tenantA.id,
        username: "staff-a",
        email: "staff-a@example.com",
        passwordHash,
        role: "operator",
        isActive: true,
      },
      { transaction: t }
    )
  );
  const staffB = await withOwnerContext((t) =>
    StaffUser.create(
      {
        tenantId: tenantB.id,
        username: "staff-b",
        email: "staff-b@example.com",
        passwordHash,
        role: "operator",
        isActive: true,
      },
      { transaction: t }
    )
  );

  const ownerStaff = await withOwnerContext((t) =>
    StaffUser.create(
      {
        tenantId: null,
        username: "owner-1",
        email: "owner@example.com",
        passwordHash,
        role: "owner",
        isActive: true,
      },
      { transaction: t }
    )
  );

  const playerA1 = await withOwnerContext((t) =>
    User.create(
      {
        tenantId: tenantA.id,
        email: "a1@example.com",
        username: "a1",
        passwordHash,
        role: "player",
        isActive: true,
      },
      { transaction: t }
    )
  );
  const playerA2 = await withOwnerContext((t) =>
    User.create(
      {
        tenantId: tenantA.id,
        email: "a2@example.com",
        username: "a2",
        passwordHash,
        role: "player",
        isActive: true,
      },
      { transaction: t }
    )
  );
  const playerB = await withOwnerContext((t) =>
    User.create(
      {
        tenantId: tenantB.id,
        email: "b1@example.com",
        username: "b1",
        passwordHash,
        role: "player",
        isActive: true,
      },
      { transaction: t }
    )
  );

  await withOwnerContext((t) =>
    Wallet.bulkCreate(
      [
        { tenantId: tenantA.id, userId: playerA1.id, balance: 10, currency: "FUN" },
        { tenantId: tenantA.id, userId: playerA2.id, balance: 5, currency: "FUN" },
        { tenantId: tenantB.id, userId: playerB.id, balance: 8, currency: "FUN" },
      ],
      { transaction: t }
    )
  );

  const tokenA = jwt.sign(
    {
      sub: staffA.id,
      type: "staff",
      role: staffA.role,
      tenantId: tenantA.id,
    },
    STAFF_JWT_SECRET,
    { expiresIn: "1h" }
  );
  const tokenB = jwt.sign(
    {
      sub: staffB.id,
      type: "staff",
      role: staffB.role,
      tenantId: tenantB.id,
    },
    STAFF_JWT_SECRET,
    { expiresIn: "1h" }
  );
  const ownerToken = jwt.sign(
    {
      sub: ownerStaff.id,
      type: "staff",
      role: ownerStaff.role,
      tenantId: ownerStaff.tenantId || null,
    },
    STAFF_JWT_SECRET,
    { expiresIn: "1h" }
  );

  const resA = await request(app)
    .get("/api/v1/admin/players")
    .set("Authorization", `Bearer ${tokenA}`);
  assert.strictEqual(resA.statusCode, 200);
  assert.strictEqual(resA.body.players.length, 2);
  const idsA = new Set(resA.body.players.map((p) => p.id));
  assert(idsA.has(playerA1.id));
  assert(idsA.has(playerA2.id));
  assert(!idsA.has(playerB.id));

  const resAPlayerB = await request(app)
    .get(`/api/v1/admin/players/${playerB.id}`)
    .set("Authorization", `Bearer ${tokenA}`);
  assert.strictEqual(resAPlayerB.statusCode, 404);

  const resB = await request(app)
    .get("/api/v1/admin/players")
    .set("Authorization", `Bearer ${tokenB}`);
  assert.strictEqual(resB.statusCode, 200);
  assert.strictEqual(resB.body.players.length, 1);
  assert.strictEqual(resB.body.players[0].id, playerB.id);

  let failed = false;
  try {
    await sequelize.transaction(async (t) => {
      await sequelize.query("SET LOCAL app.role = 'operator'", { transaction: t });
      await sequelize.query("SET LOCAL app.user_id = 'staff-test'", { transaction: t });
      await sequelize.query("SET LOCAL app.tenant_id = :tenantId", {
        transaction: t,
        replacements: { tenantId: tenantA.id },
      });
      await Voucher.create(
        {
          tenantId: tenantB.id,
          code: "X12345",
          pin: "123456",
          amount: 5,
          bonusAmount: 0,
          currency: "FUN",
          status: "new",
        },
        { transaction: t }
      );
    });
  } catch (err) {
    failed = true;
  }
  assert.strictEqual(failed, true);

  const resOwner = await request(app)
    .get("/api/v1/owner/tenants")
    .set("Authorization", `Bearer ${ownerToken}`);
  assert.strictEqual(resOwner.statusCode, 200);
  assert(resOwner.body.tenants.length >= 2);

  console.log("[test:rls] all checks passed");
  await sequelize.close();
}

run().catch((err) => {
  console.error("[test:rls] failed:", err);
  process.exit(1);
});
