// src/routes/adminPlayers.js
const express = require("express");
const { Op } = require("sequelize");

const { User, Wallet, Transaction, GameRound } = require("../models");
const {
  staffAuth,
  requirePermission,
} = require("../middleware/staffAuth");
const { PERMISSIONS } = require("../constants/permissions");

const router = express.Router();

async function getOrCreateWallet(userId) {
  let wallet = await Wallet.findOne({ where: { userId } });
  if (!wallet) {
    wallet = await Wallet.create({ userId, balance: 0 });
  }
  return wallet;
}

function toPlayerDto(user, wallet) {
  return {
    id: user.id,
    userCode: user.username,
    email: user.email,
    status: user.isActive ? "active" : "closed",
    balance: wallet ? Number(wallet.balance || 0) : 0,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
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
        include: [{ model: Wallet, as: "wallet" }],
      });

      const mapped = players.map((p) =>
        toPlayerDto(p, p.wallet || p.Wallet || null)
      );

      res.json({ ok: true, players: mapped });
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
        include: [{ model: Wallet, as: "wallet" }],
      });

      if (!player) {
        return res.status(404).json({ ok: false, error: "Player not found" });
      }

      res.json({
        ok: true,
        player: toPlayerDto(player, player.wallet || player.Wallet || null),
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

      const wallet = await getOrCreateWallet(player.id);
      const before = Number(wallet.balance || 0);
      const after = before + amount;
      wallet.balance = after;
      await wallet.save();

      await Transaction.create({
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
      const limit = Math.min(parseInt(req.query.limit || "50", 10), 200);
      const wallet = await Wallet.findOne({ where: { userId: req.params.id } });

      if (!wallet) {
        return res.json({ ok: true, transactions: [] });
      }

      const tx = await Transaction.findAll({
        where: { walletId: wallet.id },
        order: [["createdAt", "DESC"]],
        limit,
      });

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
      const limit = Math.min(parseInt(req.query.limit || "200", 10), 500);

      const rounds = await GameRound.findAll({
        where: { playerId: req.params.id },
        order: [["createdAt", "DESC"]],
        limit,
      });

      res.json({
        ok: true,
        rounds: rounds.map((r) => ({
          id: r.id,
          gameId: r.gameId,
          betAmount: Number(r.betAmount || 0),
          winAmount: Number(r.winAmount || 0),
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

module.exports = router;
