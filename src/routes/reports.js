// src/routes/reports.js
const express = require("express");
const { Op } = require("sequelize");
const { Transaction, Voucher, GameRound, User } = require("../models");
const { staffAuth, requirePermission } = require("../middleware/staffAuth");

const router = express.Router();

// helper
function parseDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// GET /admin/reports/range?from=2025-12-01&to=2025-12-02
router.get(
  "/range",
  staffAuth,
  requirePermission("finance:read"),
  async (req, res) => {
    try {
      const from = parseDateOrNull(req.query.from);
      const to = parseDateOrNull(req.query.to);

      if (!from || !to) {
        return res.status(400).json({
          ok: false,
          error: "Invalid or missing 'from'/'to' date range",
        });
      }

      // normalize to full days
      const fromStart = new Date(from);
      fromStart.setUTCHours(0, 0, 0, 0);

      const toEnd = new Date(to);
      toEnd.setUTCHours(23, 59, 59, 999);

      // vouchers in range
      const vouchers = await Voucher.findAll({
        where: {
          createdAt: { [Op.between]: [fromStart, toEnd] },
        },
      });

      // transactions in range
      const txs = await Transaction.findAll({
        where: {
          createdAt: { [Op.between]: [fromStart, toEnd] },
        },
      });

      // game rounds in range
      const rounds = await GameRound.findAll({
        where: {
          createdAt: { [Op.between]: [fromStart, toEnd] },
        },
      });

      // aggregate
      const totalVoucherAmount = vouchers.reduce(
        (sum, v) => sum + Number(v.amount || 0),
        0
      );
      const totalVoucherBonus = vouchers.reduce(
        (sum, v) => sum + Number(v.bonusAmount || 0),
        0
      );

      const totalCredits = txs
        .filter((t) => t.type === "voucher_credit" || t.type === "manual_adjustment")
        .reduce((sum, t) => sum + Number(t.amount || 0), 0);

      const totalDebits = txs
        .filter((t) => t.type === "bet_debit" || t.type === "manual_debit")
        .reduce((sum, t) => sum + Number(t.amount || 0), 0);

      const totalBetAmount = rounds.reduce(
        (sum, r) => sum + Number(r.betAmount || 0),
        0
      );
      const totalWinAmount = rounds.reduce(
        (sum, r) => sum + Number(r.winAmount || 0),
        0
      );

      const grossGamingRevenue = totalBetAmount - totalWinAmount;

      res.json({
        ok: true,
        range: {
          from: fromStart.toISOString(),
          to: toEnd.toISOString(),
        },
        summary: {
          totalVoucherAmount,
          totalVoucherBonus,
          totalCredits,
          totalDebits,
          totalBetAmount,
          totalWinAmount,
          grossGamingRevenue,
          netCashflow: totalCredits - totalDebits,
        },
        counts: {
          voucherCount: vouchers.length,
          transactionCount: txs.length,
          roundsCount: rounds.length,
        },
      });
    } catch (err) {
      console.error("[REPORTS /range] error:", err);
      res.status(500).json({ ok: false, error: "Internal error" });
    }
  }
);

module.exports = router;
