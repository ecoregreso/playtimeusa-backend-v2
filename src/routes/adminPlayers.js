// src/routes/adminPlayers.js
const express = require("express");
const { Op } = require("sequelize");

const { User, Wallet, Transaction, GameRound, Session, Voucher, StaffUser } = require("../models");
const {
  staffAuth,
  requirePermission,
} = require("../middleware/staffAuth");
const { PERMISSIONS } = require("../constants/permissions");

const router = express.Router();
const LIVE_WINDOW_MINUTES = 15;

async function getOrCreateWallet(userId, tenantId) {
  let wallet = await Wallet.findOne({ where: { userId, tenantId } });
  if (!wallet) {
    wallet = await Wallet.create({ userId, tenantId, balance: 0 });
  }
  return wallet;
}

function computeLiveStatus({ user, wallet, session }) {
  if (!user?.isActive) {
    return { liveStatus: "deprecated", isLive: false, isDeprecated: true };
  }
  const balance = Number(wallet?.balance || 0);
  const now = Date.now();
  const live =
    session &&
    !session.revokedAt &&
    new Date(session.lastSeenAt || session.updatedAt || session.createdAt).getTime() >=
      now - LIVE_WINDOW_MINUTES * 60 * 1000;

  if (live) return { liveStatus: "live", isLive: true, isDeprecated: false };
  if (balance > 0 && user.isActive) return { liveStatus: "active", isLive: false, isDeprecated: false };
  return { liveStatus: "deprecated", isLive: false, isDeprecated: true };
}

function toPlayerDto(user, wallet, session, deactivation = null) {
  const { liveStatus, isLive, isDeprecated } = computeLiveStatus({ user, wallet, session });
  const balance = wallet ? Number(wallet.balance || 0) : 0;
  return {
    id: user.id,
    userCode: user.username,
    email: user.email,
    status: user.isActive ? "active" : "closed",
    balance,
    liveStatus,
    isLive,
    isDeprecated,
    lastSeenAt: session?.lastSeenAt || session?.updatedAt || session?.createdAt || null,
    canDelete: balance <= 0,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    deactivation,
  };
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toIsoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function deactivationFromVoucher(voucher, staffMap = new Map()) {
  if (!voucher) return null;
  const metadata = voucher.metadata && typeof voucher.metadata === "object" ? voucher.metadata : {};
  const staffId =
    Number(metadata.deactivatedByStaffId || metadata.terminatedByStaffId || metadata.cashoutByStaffId || 0) || null;
  return {
    source: "voucher_termination",
    voucherId: voucher.id,
    voucherCode: voucher.code,
    terminatedAt: toIsoOrNull(metadata.terminatedAt || metadata.cashoutAt || voucher.updatedAt),
    terminatedReason: metadata.terminatedReason || metadata.deactivatedReason || null,
    cashoutAmount: toNum(metadata.cashoutAmount, 0),
    deactivatedAt: toIsoOrNull(metadata.deactivatedAt || metadata.terminatedAt || metadata.cashoutAt),
    deactivatedByStaffId: staffId,
    deactivatedByStaff: staffId ? staffMap.get(staffId) || null : null,
    profileDeactivated: Boolean(metadata.profileDeactivated),
    revokedSessionCount: toNum(metadata.revokedSessionCount, 0),
    revokedRefreshTokenCount: toNum(metadata.revokedRefreshTokenCount, 0),
  };
}

// GET /api/v1/admin/players
router.get(
  "/",
  staffAuth,
  requirePermission(PERMISSIONS.PLAYER_READ),
  async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || "200", 10), 500);
      const search = (req.query.search || "").trim();
      const status = (req.query.status || "").toLowerCase();

      const where = { role: "player" };
      if (status === "active") where.isActive = true;
      if (status === "closed" || status === "banned") where.isActive = false;

      if (search) {
        where[Op.or] = [
          { username: { [Op.iLike]: `%${search}%` } },
          { email: { [Op.iLike]: `%${search}%` } },
          { id: search },
        ];
      }

      const players = await User.findAll({
        where,
        order: [["createdAt", "DESC"]],
        limit,
      });
      const ids = players.map((p) => p.id);

      const [wallets, sessions, terminatedVouchers] = await Promise.all([
        ids.length
          ? Wallet.findAll({ where: { userId: ids } })
          : [],
        ids.length
          ? Session.findAll({
              where: {
                actorType: "user",
                userId: ids,
                revokedAt: { [Op.is]: null },
              },
              order: [["lastSeenAt", "DESC"]],
            })
          : [],
        ids.length
          ? Voucher.findAll({
              where: {
                redeemedByUserId: ids,
                status: { [Op.in]: ["terminated", "TERMINATED"] },
              },
              order: [["updatedAt", "DESC"]],
            })
          : [],
      ]);

      const walletMap = new Map(wallets.map((w) => [String(w.userId), w]));
      const sessionMap = new Map();
      for (const s of sessions) {
        const key = String(s.userId);
        if (!sessionMap.has(key)) sessionMap.set(key, s);
      }

      const latestTerminatedVoucherByUser = new Map();
      const deactivationStaffIds = new Set();
      for (const voucher of terminatedVouchers) {
        const userId = String(voucher.redeemedByUserId || "");
        if (!userId) continue;
        if (!latestTerminatedVoucherByUser.has(userId)) {
          latestTerminatedVoucherByUser.set(userId, voucher);
        }
        const meta = voucher.metadata && typeof voucher.metadata === "object" ? voucher.metadata : {};
        const staffId =
          Number(meta.deactivatedByStaffId || meta.terminatedByStaffId || meta.cashoutByStaffId || 0) || null;
        if (staffId) deactivationStaffIds.add(staffId);
      }

      const deactivationStaffRows = deactivationStaffIds.size
        ? await StaffUser.findAll({
            where: { id: { [Op.in]: Array.from(deactivationStaffIds) } },
            attributes: ["id", "username", "role"],
          })
        : [];
      const deactivationStaffMap = new Map(
        deactivationStaffRows.map((s) => [s.id, { id: s.id, username: s.username, role: s.role }])
      );

      const mapped = players.map((p) => {
        const wallet = walletMap.get(String(p.id)) || null;
        const session = sessionMap.get(String(p.id)) || null;
        const terminatedVoucher = latestTerminatedVoucherByUser.get(String(p.id)) || null;
        const deactivation = deactivationFromVoucher(terminatedVoucher, deactivationStaffMap);
        return toPlayerDto(p, wallet, session, deactivation);
      });

      const filtered =
        status === "live" || status === "active" || status === "deprecated"
          ? mapped.filter((p) => p.liveStatus === status)
          : mapped;

      res.json({ ok: true, players: filtered });
    } catch (err) {
      console.error("[ADMIN_PLAYERS] list error:", err);
      res.status(500).json({ ok: false, error: "Internal error" });
    }
  }
);

// GET /api/v1/admin/players/:id
router.get(
  "/:id",
  staffAuth,
  requirePermission(PERMISSIONS.PLAYER_READ),
  async (req, res) => {
    try {
      const player = await User.findOne({
        where: { id: req.params.id, role: "player" },
      });

      if (!player) {
        return res.status(404).json({ ok: false, error: "Player not found" });
      }

      const wallet = await Wallet.findOne({ where: { userId: player.id } });
      const session = await Session.findOne({
        where: { actorType: "user", userId: player.id, revokedAt: { [Op.is]: null } },
        order: [["lastSeenAt", "DESC"]],
      });
      const terminatedVoucher = await Voucher.findOne({
        where: {
          redeemedByUserId: player.id,
          status: { [Op.in]: ["terminated", "TERMINATED"] },
        },
        order: [["updatedAt", "DESC"]],
      });
      const staffId =
        Number(
          terminatedVoucher?.metadata?.deactivatedByStaffId ||
            terminatedVoucher?.metadata?.terminatedByStaffId ||
            terminatedVoucher?.metadata?.cashoutByStaffId ||
            0
        ) || null;
      const staff = staffId
        ? await StaffUser.findOne({
            where: { id: staffId },
            attributes: ["id", "username", "role"],
          })
        : null;

      res.json({
        ok: true,
        player: toPlayerDto(
          player,
          wallet,
          session,
          deactivationFromVoucher(
            terminatedVoucher,
            new Map(
              staff ? [[staff.id, { id: staff.id, username: staff.username, role: staff.role }]] : []
            )
          )
        ),
      });
    } catch (err) {
      console.error("[ADMIN_PLAYERS] detail error:", err);
      res.status(500).json({ ok: false, error: "Internal error" });
    }
  }
);

// POST /api/v1/admin/players/:id/adjust
router.post(
  "/:id/adjust",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_WRITE),
  async (req, res) => {
    const amount = Number(req.body?.amount || 0);
    const reason = req.body?.reason || "Manual adjustment";

    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ ok: false, error: "Invalid amount" });
    }

    try {
      const player = await User.findOne({
        where: { id: req.params.id, role: "player" },
      });
      if (!player) {
        return res.status(404).json({ ok: false, error: "Player not found" });
      }

      const wallet = await getOrCreateWallet(player.id, req.staff?.tenantId || null);
      const before = Number(wallet.balance || 0);
      const after = before + amount;
      wallet.balance = after;
      await wallet.save();

      await Transaction.create({
        tenantId: req.staff?.tenantId || null,
        walletId: wallet.id,
        type: "manual_adjustment",
        amount,
        balanceBefore: before,
        balanceAfter: after,
        reference: reason,
        createdByUserId: null,
      });

      res.json({
        ok: true,
        player: toPlayerDto(player, wallet),
      });
    } catch (err) {
      console.error("[ADMIN_PLAYERS] adjust error:", err);
      res.status(500).json({ ok: false, error: "Failed to adjust balance" });
    }
  }
);

// GET /api/v1/admin/players/:id/transactions
router.get(
  "/:id/transactions",
  staffAuth,
  requirePermission(PERMISSIONS.PLAYER_READ),
  async (req, res) => {
    try {
      const all = String(req.query.all || "").toLowerCase() === "1";
      const limit = all ? null : Math.min(parseInt(req.query.limit || "50", 10), 200);
      const wallet = await Wallet.findOne({ where: { userId: req.params.id } });

      if (!wallet) {
        return res.json({ ok: true, transactions: [] });
      }

      const txQuery = {
        where: { walletId: wallet.id },
        order: [["createdAt", "DESC"]],
      };
      if (limit) txQuery.limit = limit;

      const tx = await Transaction.findAll(txQuery);

      res.json({ ok: true, transactions: tx });
    } catch (err) {
      console.error("[ADMIN_PLAYERS] transactions error:", err);
      res.status(500).json({ ok: false, error: "Internal error" });
    }
  }
);

// GET /api/v1/admin/players/:id/rounds
router.get(
  "/:id/rounds",
  staffAuth,
  requirePermission(PERMISSIONS.PLAYER_READ),
  async (req, res) => {
    try {
      const all = String(req.query.all || "").toLowerCase() === "1";
      const limit = all ? null : Math.min(parseInt(req.query.limit || "200", 10), 500);

      const roundQuery = {
        where: { playerId: req.params.id },
        order: [["createdAt", "DESC"]],
      };
      if (limit) roundQuery.limit = limit;

      const rounds = await GameRound.findAll(roundQuery);

      res.json({
        ok: true,
        rounds: rounds.map((r) => ({
          id: r.id,
          gameId: r.gameId,
          betAmount: Number(r.betAmount || 0),
          winAmount: Number(r.winAmount || 0),
          status: r.status,
          sessionId: r?.metadata?.sessionId || null,
          result: r.result || null,
          createdAt: r.createdAt,
        })),
      });
    } catch (err) {
      console.error("[ADMIN_PLAYERS] rounds error:", err);
      res.status(500).json({ ok: false, error: "Internal error" });
    }
  }
);

// GET /api/v1/admin/players/:id/sessions
router.get(
  "/:id/sessions",
  staffAuth,
  requirePermission(PERMISSIONS.PLAYER_READ),
  async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || "200", 10), 500);
      const sessions = await Session.findAll({
        where: { actorType: "user", userId: req.params.id },
        order: [["lastSeenAt", "DESC"]],
        limit,
      });

      res.json({ ok: true, sessions });
    } catch (err) {
      console.error("[ADMIN_PLAYERS] sessions error:", err);
      res.status(500).json({ ok: false, error: "Internal error" });
    }
  }
);

// DELETE /api/v1/admin/players/:id
router.delete(
  "/:id",
  staffAuth,
  requirePermission(PERMISSIONS.PLAYER_WRITE),
  async (req, res) => {
    try {
      const player = await User.findOne({
        where: { id: req.params.id, role: "player" },
      });
      if (!player) {
        return res.status(404).json({ ok: false, error: "Player not found" });
      }

      const wallet = await Wallet.findOne({ where: { userId: player.id } });
      const balance = wallet ? Number(wallet.balance || 0) : 0;
      if (balance > 0) {
        return res
          .status(400)
          .json({ ok: false, error: "Cannot delete player with positive balance" });
      }

      await Session.destroy({ where: { actorType: "user", userId: player.id } });
      await Wallet.destroy({ where: { userId: player.id } });
      await User.destroy({ where: { id: player.id } });

      res.json({ ok: true });
    } catch (err) {
      console.error("[ADMIN_PLAYERS] delete error:", err);
      res.status(500).json({ ok: false, error: "Failed to delete player" });
    }
  }
);

module.exports = router;
