// src/routes/adminPlayers.js
const express = require("express");
const { User, Wallet, GameRound } = require("../models");
const { staffAuth, requirePermission } = require("../middleware/staffAuth");

const router = express.Router();

// GET /admin/players
router.get(
  "/",
  staffAuth,
  requirePermission("player:read"),
  async (req, res) => {
    try {
      const players = await User.findAll({
        where: { role: "player" },
        include: [{ model: Wallet, as: "wallet" }],
        order: [["createdAt", "DESC"]],
        limit: 200,
      });

      res.json({
        ok: true,
        players: players.map((p) => ({
          id: p.id,
          email: p.email,
          username: p.username,
          isActive: p.isActive,
          createdAt: p.createdAt,
          wallet: p.wallet
            ? {
                id: p.wallet.id,
                balance: Number(p.wallet.balance || 0),
                currency: p.wallet.currency,
              }
            : null,
        })),
      });
    } catch (err) {
      console.error("[ADMIN_PLAYERS] list error:", err);
      res.status(500).json({ ok: false, error: "Internal error" });
    }
  }
);

// GET /admin/players/:id/rounds
router.get(
  "/:id/rounds",
  staffAuth,
  requirePermission("betlog:read"),
  async (req, res) => {
    try {
      const userId = req.params.id;

      const rounds = await GameRound.findAll({
        where: { userId },
        order: [["createdAt", "DESC"]],
        limit: 200,
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
