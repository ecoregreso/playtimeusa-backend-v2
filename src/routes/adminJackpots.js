const express = require("express");
const { Op } = require("sequelize");
const { requireStaffAuth, PERMISSIONS } = require("../middleware/staffAuth");
const {
  getJackpotSummary,
  updateJackpotTarget,
  triggerJackpotHit,
} = require("../services/jackpotService");
const { User, Voucher } = require("../models");

const router = express.Router();

function resolveTenantScope(staff = {}) {
  return staff.role === "owner" ? null : staff.tenantId || null;
}

function looksLikeUuid(value = "") {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function resolvePlayerId({ playerId, playerLookup, voucherCode, tenantScope }) {
  const candidate = String(playerLookup || playerId || "").trim();
  const voucherLookup = String(voucherCode || "").trim();
  const tenantClause = tenantScope ? { tenantId: tenantScope } : {};

  // 1) Direct UUID
  if (candidate && looksLikeUuid(candidate)) {
    const user = await User.findOne({ where: { id: candidate, ...tenantClause } });
    if (user) return user.id;
  }

  // 2) Username/userCode/loginCode (player ID shown in UI)
  if (candidate) {
    const userByCode = await User.findOne({
      where: {
        username: candidate,
        ...tenantClause,
      },
    });
    if (userByCode) return userByCode.id;

    const voucherByCode = await Voucher.findOne({
      where: {
        code: candidate,
        ...(tenantScope ? { tenantId: { [Op.or]: [tenantScope, null] } } : {}),
      },
    });
    if (voucherByCode?.redeemedByUserId) {
      const userFromVoucher = await User.findOne({
        where: { id: voucherByCode.redeemedByUserId, ...tenantClause },
      });
      if (userFromVoucher) return userFromVoucher.id;
    }
  }

  // 3) Explicit voucherCode field
  if (voucherLookup) {
    const voucher = await Voucher.findOne({
      where: {
        code: voucherLookup,
        ...(tenantScope ? { tenantId: { [Op.or]: [tenantScope, null] } } : {}),
      },
    });
    if (voucher?.redeemedByUserId) {
      const userFromVoucher = await User.findOne({
        where: { id: voucher.redeemedByUserId, ...tenantClause },
      });
      if (userFromVoucher) return userFromVoucher.id;
    }
  }

  return null;
}

router.get(
  "/summary",
  requireStaffAuth([PERMISSIONS.FINANCE_READ]),
  async (req, res) => {
    try {
      const staff = req.staff || {};
      const tenantScope = resolveTenantScope(staff);
      const data = await getJackpotSummary({ tenantId: tenantScope, includeGlobal: true });
      res.json({ ok: true, data });
    } catch (err) {
      console.error("[ADMIN_JACKPOTS] summary error:", err);
      res.status(500).json({ ok: false, error: "Failed to load jackpots" });
    }
  }
);

router.patch(
  "/:jackpotId/target",
  requireStaffAuth([PERMISSIONS.FINANCE_WRITE]),
  async (req, res) => {
    try {
      const { jackpotId } = req.params;
      const { triggerCents, targetCents, rangeMinCents, rangeMaxCents, contributionBps } = req.body || {};
      const target = triggerCents ?? targetCents;
      if (target === undefined || target === null) {
        return res.status(400).json({ ok: false, error: "triggerCents is required" });
      }

      const staff = req.staff || {};
      const tenantScope = resolveTenantScope(staff);
      const jackpot = await updateJackpotTarget({
        jackpotId,
        triggerCents: target,
        rangeMinCents,
        rangeMaxCents,
        contributionBps,
        tenantScope,
      });
      res.json({ ok: true, data: jackpot });
    } catch (err) {
      console.error("[ADMIN_JACKPOTS] update target error:", err);
      const status = err.status || 500;
      res.status(status).json({ ok: false, error: err.message || "Failed to update jackpot target" });
    }
  }
);

router.post(
  "/:jackpotId/trigger",
  requireStaffAuth([PERMISSIONS.FINANCE_WRITE]),
  async (req, res) => {
    try {
      const { jackpotId } = req.params;
      const { payoutCents, playerId, playerLookup, voucherCode, triggeredBy } = req.body || {};
      const staff = req.staff || {};
      const tenantScope = resolveTenantScope(staff);
      const resolvedPlayerId = await resolvePlayerId({ playerId, playerLookup, voucherCode, tenantScope });

      if ((playerId || playerLookup || voucherCode) && !resolvedPlayerId) {
        return res.status(404).json({ ok: false, error: "Player not found for provided ID / voucher code" });
      }

      const result = await triggerJackpotHit({
        jackpotId,
        tenantScope,
        payoutCents,
        playerId: resolvedPlayerId || null,
        triggeredBy: triggeredBy || `staff:${staff.id || "manual"}`,
      });
      res.json({ ok: true, data: result });
    } catch (err) {
      console.error("[ADMIN_JACKPOTS] manual trigger error:", err);
      const status = err.status || 500;
      res.status(status).json({ ok: false, error: err.message || "Failed to trigger jackpot" });
    }
  }
);

module.exports = router;
