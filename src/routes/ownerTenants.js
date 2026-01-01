const express = require("express");
const { sequelize } = require("../db");
const {
  Tenant,
  Distributor,
  TenantWallet,
  TenantVoucherPool,
  CreditLedger,
  OwnerSetting,
} = require("../models");
const { staffAuth } = require("../middleware/staffAuth");

const router = express.Router();

function requireOwner(req, res, next) {
  if (!req.staff || req.staff.role !== "owner") {
    return res.status(403).json({ ok: false, error: "Owner access required" });
  }
  return next();
}

const parseBrandPayload = (payload) => {
  if (!payload) return null;
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch (err) {
      return null;
    }
  }
  if (typeof payload === "object") {
    return payload;
  }
  return null;
};

router.get("/brand", staffAuth, requireOwner, async (req, res) => {
  try {
    const row = await OwnerSetting.findByPk("brand");
    if (!row?.value) {
      return res.json({ ok: true, brand: null });
    }
    const parsed = parseBrandPayload(row.value);
    res.json({ ok: true, brand: parsed });
  } catch (err) {
    console.error("[OWNER] get brand error:", err);
    res.status(500).json({ ok: false, error: "Failed to load brand" });
  }
});

router.post("/brand", staffAuth, requireOwner, async (req, res) => {
  try {
    const incoming = req.body?.brand ?? req.body;
    const parsed = parseBrandPayload(incoming);
    if (!parsed || typeof parsed !== "object") {
      return res.status(400).json({ ok: false, error: "brand payload is invalid" });
    }

    const value = JSON.stringify(parsed);
    await OwnerSetting.upsert({ key: "brand", value });
    res.json({ ok: true, brand: parsed });
  } catch (err) {
    console.error("[OWNER] update brand error:", err);
    res.status(500).json({ ok: false, error: "Failed to update brand" });
  }
});

router.get("/tenants", staffAuth, requireOwner, async (req, res) => {
  try {
    const tenants = await Tenant.findAll({
      order: [["createdAt", "DESC"]],
      include: [
        { model: TenantWallet, attributes: ["balanceCents", "currency"] },
        { model: TenantVoucherPool, attributes: ["poolBalanceCents", "currency"] },
        { model: Distributor, attributes: ["id", "name", "status"] },
      ],
    });
    res.json({ ok: true, tenants });
  } catch (err) {
    console.error("[OWNER] list tenants error:", err);
    res.status(500).json({ ok: false, error: "Failed to list tenants" });
  }
});

router.post("/tenants", staffAuth, requireOwner, async (req, res) => {
  try {
    const { name, distributorId, status } = req.body || {};
    if (!name) {
      return res.status(400).json({ ok: false, error: "name is required" });
    }

    const result = await sequelize.transaction(
      { transaction: req.transaction },
      async (t) => {
        const tenant = await Tenant.create(
          {
            name: String(name).trim(),
            distributorId: distributorId || null,
            status: status || "active",
          },
          { transaction: t }
        );

        await TenantWallet.create(
          {
            tenantId: tenant.id,
            balanceCents: 0,
            currency: "FUN",
          },
          { transaction: t }
        );

        await TenantVoucherPool.create(
          {
            tenantId: tenant.id,
            poolBalanceCents: 0,
            currency: "FUN",
          },
          { transaction: t }
        );

        return tenant;
      }
    );

    res.status(201).json({ ok: true, tenant: result });
  } catch (err) {
    console.error("[OWNER] create tenant error:", err);
    res.status(500).json({ ok: false, error: "Failed to create tenant" });
  }
});

router.get("/distributors", staffAuth, requireOwner, async (req, res) => {
  try {
    const distributors = await Distributor.findAll({ order: [["createdAt", "DESC"]] });
    res.json({ ok: true, distributors });
  } catch (err) {
    console.error("[OWNER] list distributors error:", err);
    res.status(500).json({ ok: false, error: "Failed to list distributors" });
  }
});

router.post("/distributors", staffAuth, requireOwner, async (req, res) => {
  try {
    const { name, status } = req.body || {};
    if (!name) {
      return res.status(400).json({ ok: false, error: "name is required" });
    }
    const distributor = await Distributor.create({
      name: String(name).trim(),
      status: status || "active",
    });
    res.status(201).json({ ok: true, distributor });
  } catch (err) {
    console.error("[OWNER] create distributor error:", err);
    res.status(500).json({ ok: false, error: "Failed to create distributor" });
  }
});

router.post("/tenants/:id/credits", staffAuth, requireOwner, async (req, res) => {
  try {
    const amountCents = Number(req.body?.amountCents);
    const memo = req.body?.memo || null;
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(400).json({ ok: false, error: "amountCents must be > 0" });
    }

    const tenantId = req.params.id;
    const result = await sequelize.transaction(
      { transaction: req.transaction },
      async (t) => {
        let wallet = await TenantWallet.findOne({
          where: { tenantId },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        if (!wallet) {
          wallet = await TenantWallet.create(
            { tenantId, balanceCents: 0, currency: "FUN" },
            { transaction: t }
          );
        }

        wallet.balanceCents = Number(wallet.balanceCents || 0) + Math.floor(amountCents);
        await wallet.save({ transaction: t });

        await CreditLedger.create(
          {
            tenantId,
            actorUserId: req.staff?.id || null,
            actionType: "issue_credits",
            amountCents: Math.floor(amountCents),
            memo,
          },
          { transaction: t }
        );

        return wallet;
      }
    );

    res.json({ ok: true, wallet: result });
  } catch (err) {
    console.error("[OWNER] issue credits error:", err);
    res.status(500).json({ ok: false, error: "Failed to issue credits" });
  }
});

router.post(
  "/tenants/:id/voucher-pool",
  staffAuth,
  requireOwner,
  async (req, res) => {
    try {
      const amountCents = Number(req.body?.amountCents);
      const memo = req.body?.memo || null;
      if (!Number.isFinite(amountCents) || amountCents <= 0) {
        return res.status(400).json({ ok: false, error: "amountCents must be > 0" });
      }

      const tenantId = req.params.id;
      const result = await sequelize.transaction(
        { transaction: req.transaction },
        async (t) => {
          let wallet = await TenantWallet.findOne({
            where: { tenantId },
            transaction: t,
            lock: t.LOCK.UPDATE,
          });
          if (!wallet) {
            wallet = await TenantWallet.create(
              { tenantId, balanceCents: 0, currency: "FUN" },
              { transaction: t }
            );
          }

          const debit = Math.floor(amountCents);
          if (Number(wallet.balanceCents || 0) < debit) {
            throw new Error("INSUFFICIENT_TENANT_BALANCE");
          }

          let pool = await TenantVoucherPool.findOne({
            where: { tenantId },
            transaction: t,
            lock: t.LOCK.UPDATE,
          });
          if (!pool) {
            pool = await TenantVoucherPool.create(
              { tenantId, poolBalanceCents: 0, currency: "FUN" },
              { transaction: t }
            );
          }

          wallet.balanceCents = Number(wallet.balanceCents || 0) - debit;
          pool.poolBalanceCents = Number(pool.poolBalanceCents || 0) + debit;

          await wallet.save({ transaction: t });
          await pool.save({ transaction: t });

          await CreditLedger.create(
            {
              tenantId,
              actorUserId: req.staff?.id || null,
              actionType: "allocate_voucher_pool",
              amountCents: debit,
              memo,
            },
            { transaction: t }
          );

          return { wallet, pool };
        }
      );

      res.json({ ok: true, ...result });
    } catch (err) {
      if (err?.message === "INSUFFICIENT_TENANT_BALANCE") {
        return res.status(400).json({ ok: false, error: "Insufficient tenant balance" });
      }
      console.error("[OWNER] allocate voucher pool error:", err);
      res.status(500).json({ ok: false, error: "Failed to allocate voucher pool" });
    }
  }
);

module.exports = router;
