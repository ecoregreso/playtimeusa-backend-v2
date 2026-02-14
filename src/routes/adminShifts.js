const express = require("express");
const { Op } = require("sequelize");
const { requireStaffAuth, PERMISSIONS } = require("../middleware/staffAuth");
const { Voucher, Transaction, StaffUser, ShiftClosure } = require("../models");

const router = express.Router();

function normalizeTenantId(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function resolveTenantScope(staff = {}, tenantIdOverride = null) {
  if (staff.role === "owner") {
    return normalizeTenantId(tenantIdOverride || staff.tenantId || null);
  }
  return staff.tenantId || null;
}

function normalizeStaffId(value) {
  const num = Number(value || 0);
  if (!Number.isInteger(num) || num <= 0) return null;
  return num;
}

function startEndFromDate(dateStr) {
  const base = dateStr ? new Date(dateStr) : new Date();
  const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 1);
  return { start, end };
}

function ensureBucket(map, staffId) {
  if (!map.has(staffId)) {
    map.set(staffId, {
      staffId,
      vouchers: {
        createdCount: 0,
        createdAmount: 0,
        redeemedCount: 0,
        redeemedAmount: 0,
        openCount: 0,
        openAmount: 0,
        cashedOutCount: 0,
        cashedOutAmount: 0,
      },
      expectedBalance: 0,
    });
  }
  return map.get(staffId);
}

router.get("/summary", requireStaffAuth([PERMISSIONS.FINANCE_READ]), async (req, res) => {
  try {
    const staff = req.staff || {};
    const tenantId = resolveTenantScope(staff, req.query?.tenantId || null);
    if (!tenantId) {
      return res
        .status(400)
        .json({ ok: false, error: "Tenant is required for shift summary (owners must pass tenantId)." });
    }

    const { start, end } = startEndFromDate(req.query.date);

    const cashiers = await StaffUser.findAll({
      where: { tenantId, role: "cashier" },
      attributes: ["id", "username", "role"],
    });
    const staffMap = new Map();
    cashiers.forEach((cashier) => {
      if (cashier?.id) {
        ensureBucket(staffMap, Number(cashier.id));
      }
    });

    const vouchers = await Voucher.findAll({
      where: {
        tenantId,
        [Op.or]: [
          { createdAt: { [Op.between]: [start, end] } },
          { redeemedAt: { [Op.between]: [start, end] } },
        ],
      },
    });

    vouchers.forEach((v) => {
      const creator = normalizeStaffId(v.createdByUserId || v.metadata?.createdByStaffId || null);
      if (creator) {
        const bucket = ensureBucket(staffMap, creator);
        const amt = Number(v.amount || 0);
        bucket.vouchers.createdCount += 1;
        bucket.vouchers.createdAmount += amt;
        if ((v.status || "").toLowerCase() === "new") {
          bucket.vouchers.openCount += 1;
          bucket.vouchers.openAmount += amt;
        }
      }

      const redeemedAt = v.redeemedAt || v.redeemed_at;
      if (redeemedAt && new Date(redeemedAt) >= start && new Date(redeemedAt) < end) {
        const redeemer = normalizeStaffId(
          v.metadata?.redeemedByStaffId || v.redeemedByUserId || v.redeemedBy || null
        );
        if (redeemer) {
          const bucket = ensureBucket(staffMap, redeemer);
          const amt = Number(v.amount || 0);
          bucket.vouchers.redeemedCount += 1;
          bucket.vouchers.redeemedAmount += amt;
        }
      }
    });

    const cashedOutTx = await Transaction.findAll({
      where: {
        tenantId,
        type: "voucher_debit",
        createdAt: { [Op.between]: [start, end] },
      },
    });

    cashedOutTx.forEach((tx) => {
      const metadata = tx.metadata && typeof tx.metadata === "object" ? tx.metadata : {};
      const staffId = normalizeStaffId(metadata.cashoutByStaffId || tx.createdByUserId || null);
      if (!staffId) return;
      const bucket = ensureBucket(staffMap, staffId);
      const amt = Number(tx.amount || 0);
      bucket.vouchers.cashedOutCount += 1;
      bucket.vouchers.cashedOutAmount += amt;
    });

    const summaries = [];
    staffMap.forEach((bucket, staffId) => {
      bucket.expectedBalance =
        bucket.vouchers.createdAmount - bucket.vouchers.redeemedAmount - bucket.vouchers.cashedOutAmount;
      summaries.push(bucket);
    });

    const closures = await ShiftClosure.findAll({
      where: {
        tenantId,
        startAt: { [Op.gte]: start },
        endAt: { [Op.lte]: end },
      },
      order: [["closedAt", "DESC"]],
    });

    const staffMeta = cashiers.reduce((acc, s) => {
      acc[s.id] = { id: s.id, username: s.username, role: s.role };
      return acc;
    }, {});

    const scopedStaffIds = new Set(Array.from(staffMap.keys()).map((id) => Number(id)).filter(Boolean));
    cashiers.forEach((cashier) => {
      if (cashier?.id) scopedStaffIds.add(Number(cashier.id));
    });

    if (scopedStaffIds.size) {
      const staffRows = await StaffUser.findAll({
        where: {
          tenantId,
          id: { [Op.in]: Array.from(scopedStaffIds) },
        },
        attributes: ["id", "username", "role"],
      });
      staffRows.forEach((s) => {
        staffMeta[s.id] = { id: s.id, username: s.username, role: s.role };
      });
    }

    const summariesWithStaff = summaries
      .map((row) => ({
        ...row,
        staff: staffMeta[row.staffId] || null,
      }))
      .sort((a, b) => {
        const aName = String(a.staff?.username || "").toLowerCase();
        const bName = String(b.staff?.username || "").toLowerCase();
        if (aName && bName) return aName.localeCompare(bName);
        return Number(a.staffId || 0) - Number(b.staffId || 0);
      });

    res.json({
      ok: true,
      data: { start, end, staff: staffMeta, summaries: summariesWithStaff, closures },
    });
  } catch (err) {
    console.error("[ADMIN_SHIFTS] summary error:", err);
    res.status(500).json({ ok: false, error: "Failed to load shift summary" });
  }
});

router.post("/close", requireStaffAuth([PERMISSIONS.FINANCE_WRITE]), async (req, res) => {
  try {
    const staff = req.staff || {};
    const tenantId = resolveTenantScope(staff, req.body?.tenantId || req.query?.tenantId || null);
    if (!tenantId) {
      return res.status(400).json({ ok: false, error: "Tenant is required (owners must pass tenantId)." });
    }
    const { staffId, startAt, endAt, checklist, notes, expectedBalance, actualBalance, summary } = req.body || {};
    const normalizedStaffId = normalizeStaffId(staffId);
    if (!normalizedStaffId || !startAt || !endAt) {
      return res.status(400).json({ ok: false, error: "staffId, startAt, endAt are required" });
    }

    const cashier = await StaffUser.findOne({ where: { id: normalizedStaffId, tenantId } });
    if (!cashier) {
      return res.status(404).json({ ok: false, error: "Staff not found for tenant" });
    }

    const start = new Date(startAt);
    const end = new Date(endAt);
    let closure = await ShiftClosure.findOne({
      where: { tenantId, staffId: normalizedStaffId, startAt: start, endAt: end },
    });
    if (!closure) {
      closure = await ShiftClosure.create({
        tenantId,
        staffId: normalizedStaffId,
        startAt: start,
        endAt: end,
        checklist: checklist || null,
        notes: notes || null,
        expectedBalance: expectedBalance ?? null,
        actualBalance: actualBalance ?? null,
        summary: summary || null,
        closedAt: new Date(),
      });
    } else {
      closure.checklist = checklist || closure.checklist;
      closure.notes = notes || closure.notes;
      closure.expectedBalance = expectedBalance ?? closure.expectedBalance;
      closure.actualBalance = actualBalance ?? closure.actualBalance;
      closure.summary = summary || closure.summary;
      closure.closedAt = new Date();
      await closure.save();
    }

    res.json({ ok: true, data: closure });
  } catch (err) {
    console.error("[ADMIN_SHIFTS] close error:", err);
    res.status(500).json({ ok: false, error: "Failed to close shift" });
  }
});

module.exports = router;
