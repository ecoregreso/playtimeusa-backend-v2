// src/routes/adminAudit.js
const express = require("express");
const { QueryTypes } = require("sequelize");

const { sequelize } = require("../db");
const { Transaction, Wallet, Voucher, GameRound } = require("../models");
const {
  staffAuth,
  requirePermission,
} = require("../middleware/staffAuth");
const { PERMISSIONS } = require("../constants/permissions");
const analytics = require("../services/analyticsService");

const router = express.Router();

const ANALYTICS_SCHEMA = {
  ledger_events: [
    "tenant_id",
    "ts",
    "playerId",
    "sessionId",
    "agentId",
    "cashierId",
    "gameKey",
    "eventType",
    "amountCents",
    "betCents",
    "winCents",
    "balanceCents",
    "meta",
  ],
  session_snapshots: [
    "tenant_id",
    "sessionId",
    "playerId",
    "startedAt",
    "endedAt",
    "startBalanceCents",
    "endBalanceCents",
    "totalBetsCents",
    "totalWinsCents",
    "netCents",
    "gameCount",
    "spins",
  ],
  game_configs: ["tenant_id", "gameKey", "provider", "expectedRtp", "volatilityLabel"],
  support_tickets: ["tenant_id", "createdAt", "resolvedAt", "assignedStaffId"],
  deposit_intents: ["tenant_id", "createdAt", "creditedAt", "metadata"],
  withdrawal_intents: ["tenant_id", "createdAt", "sentAt", "metadata"],
  vouchers: ["tenant_id", "createdAt", "redeemedAt", "expiresAt"],
  sessions: ["tenant_id", "createdAt", "lastSeenAt", "actorType", "userId"],
  users: ["tenant_id", "createdAt", "role"],
  game_rounds: ["tenant_id", "createdAt", "status", "gameId", "betAmount", "winAmount"],
};

async function tableExists(tableName) {
  const rows = await sequelize.query("SELECT to_regclass(:tableName) AS name", {
    replacements: { tableName: `public.${tableName}` },
    type: QueryTypes.SELECT,
  });
  return Boolean(rows?.[0]?.name);
}

async function listColumns(tableName) {
  const rows = await sequelize.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = :tableName`,
    { replacements: { tableName }, type: QueryTypes.SELECT }
  );
  return rows.map((row) => row.column_name);
}

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
  "/health",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_READ),
  async (req, res) => {
    try {
      const tables = {};
      const missingTables = [];
      const missingColumns = {};

      for (const [table, columns] of Object.entries(ANALYTICS_SCHEMA)) {
        const exists = await tableExists(table);
        if (!exists) {
          missingTables.push(table);
          tables[table] = { exists: false, missing: columns };
          continue;
        }

        const present = new Set(await listColumns(table));
        const missing = columns.filter((col) => !present.has(col));
        if (missing.length) {
          missingColumns[table] = missing;
        }
        tables[table] = { exists: true, missing };
      }

      return res.json({
        ok: true,
        issues: missingTables.length > 0 || Object.keys(missingColumns).length > 0,
        missingTables,
        missingColumns,
        tables,
      });
    } catch (err) {
      console.error("[ADMIN_AUDIT] health error:", err);
      return res.status(500).json({ ok: false, error: "Failed to inspect analytics schema" });
    }
  }
);

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
