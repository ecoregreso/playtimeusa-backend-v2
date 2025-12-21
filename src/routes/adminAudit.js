// src/routes/adminAudit.js
const express = require("express");

const { Transaction, Wallet, Voucher, GameRound } = require("../models");
const {
  staffAuth,
  requirePermission,
} = require("../middleware/staffAuth");
const { PERMISSIONS } = require("../constants/permissions");

const router = express.Router();

// GET /api/v1/admin/audit
router.get(
  "/",
  staffAuth,
  requirePermission(PERMISSIONS.PLAYER_READ),
  async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || "120", 10), 500);

      const [tx, vouchers, rounds] = await Promise.all([
        Transaction.findAll({
          order: [["createdAt", "DESC"]],
          limit,
          include: [{ model: Wallet, as: "wallet" }],
        }),
        Voucher.findAll({
          order: [["createdAt", "DESC"]],
          limit,
        }),
        GameRound.findAll({
          order: [["createdAt", "DESC"]],
          limit,
        }),
      ]);

      const events = [];

      tx.forEach((t) => {
        events.push({
          id: `tx-${t.id}`,
          type: "transaction",
          subtype: t.type,
          amount: Number(t.amount || 0),
          reference: t.reference || null,
          actor: t.wallet ? { userId: t.wallet.userId } : null,
          createdAt: t.createdAt,
        });
      });

      vouchers.forEach((v) => {
        events.push({
          id: `voucher-${v.id}`,
          type: "voucher_created",
          code: v.code,
          amount: Number(v.amount || 0),
          createdAt: v.createdAt,
          actor: v.createdByStaffId ? { staffId: v.createdByStaffId } : null,
        });
        if (v.redeemedAt) {
          events.push({
            id: `voucher-red-${v.id}`,
            type: "voucher_redeemed",
            code: v.code,
            amount: Number(v.amount || 0),
            createdAt: v.redeemedAt,
            actor: v.redeemedByUserId ? { userId: v.redeemedByUserId } : null,
          });
        }
      });

      rounds.forEach((r) => {
        events.push({
          id: `round-${r.id}`,
          type: "game_round",
          gameId: r.gameId,
          betAmount: Number(r.betAmount || 0),
          winAmount: Number(r.winAmount || 0),
          playerId: r.playerId,
          createdAt: r.createdAt,
        });
      });

      const sorted = events
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )
        .slice(0, limit);

      res.json({ ok: true, events: sorted });
    } catch (err) {
      console.error("[ADMIN_AUDIT] error:", err);
      res.status(500).json({ ok: false, error: "Failed to load audit log" });
    }
  }
);

module.exports = router;
