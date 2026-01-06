// src/routes/adminAudit.js
const express = require("express");

const { Transaction, Wallet, Voucher, GameRound } = require("../models");
const {
  staffAuth,
  requirePermission,
} = require("../middleware/staffAuth");
const { PERMISSIONS } = require("../constants/permissions");
const analytics = require("../services/analyticsService");

const router = express.Router();

function isMissingTableError(err) {
  const code = err?.original?.code || err?.parent?.code;
  return code === "42P01";
}

function getDbErrorCode(err) {
  return err?.original?.code || err?.parent?.code || null;
}

function shouldSoftFailAudit(err) {
  const code = getDbErrorCode(err);
  if (code && ["42P01", "42703", "42883", "42P07", "42P04"].includes(code)) {
    return true;
  }
  const message = String(err?.message || "");
  if (message.includes("does not exist")) return true;
  if (err?.name === "SequelizeDatabaseError" && code) return true;
  return false;
}

function buildAuditWarning(err) {
  const code = getDbErrorCode(err);
  const suffix = code ? ` (${code})` : "";
  return `Audit data is unavailable because analytics tables or schema are missing${suffix}.`;
}

async function safeFindAll(model, options) {
  try {
    return await model.findAll(options);
  } catch (err) {
    if (isMissingTableError(err)) return [];
    throw err;
  }
}

// GET /api/v1/admin/audit
router.get(
  "/",
  staffAuth,
  requirePermission(PERMISSIONS.PLAYER_READ),
  async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || "120", 10), 500);

      const [tx, vouchers, rounds] = await Promise.all([
        safeFindAll(Transaction, {
          order: [["createdAt", "DESC"]],
          limit,
          include: [{ model: Wallet, as: "wallet" }],
        }),
        safeFindAll(Voucher, {
          order: [["createdAt", "DESC"]],
          limit,
        }),
        safeFindAll(GameRound, {
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

// GET /api/v1/admin/audit/run
router.get(
  "/run",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_READ),
  async (req, res) => {
    let range;
    try {
      range = analytics.parseRange(req.query);
      const findings = await analytics.runAudit(range, {});
      return res.json({
        ok: true,
        range: {
          from: range.from,
          to: range.to,
          bucket: range.bucket,
          timezone: range.timezone,
        },
        findings,
      });
    } catch (err) {
      if ((isMissingTableError(err) || shouldSoftFailAudit(err)) && range) {
        return res.json({
          ok: true,
          range: {
            from: range.from,
            to: range.to,
            bucket: range.bucket,
            timezone: range.timezone,
          },
          findings: [],
          warnings: [buildAuditWarning(err)],
        });
      }
      console.error("[ADMIN_AUDIT] run error:", err);
      return res.status(500).json({ ok: false, error: "Failed to run audit" });
    }
  }
);

module.exports = router;
