// src/routes/adminPlayers.js
const express = require("express");
const { Op } = require("sequelize");
const { requireAuth, requireRole } = require("../middleware/auth");
const { User, Wallet, Transaction, GameRound } = require("../models");

const router = express.Router();

/**
 * GET /admin/players/search?q=...
 * Admin search by email / username / id
 */
router.get(
  "/search",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const q = (req.query.q || "").trim();

      if (!q) {
        return res.status(400).json({ error: "Missing search query ?q=" });
      }

      const where = {
        [Op.or]: [
          { email: { [Op.iLike]: `%${q}%` } },
          { username: { [Op.iLike]: `%${q}%` } },
        ],
      };

      // If q looks like a UUID, allow direct id match too
      if (/^[0-9a-fA-F-]{32,36}$/.test(q)) {
        where[Op.or].push({ id: q });
      }

      const players = await User.findAll({
        where,
        order: [["createdAt", "DESC"]],
        limit: 25,
        attributes: ["id", "email", "username", "role", "isActive", "createdAt"],
      });

      return res.json(players);
    } catch (err) {
      console.error("[ADMIN PLAYERS] GET /search error:", err);
      return res.status(500).json({ error: "Failed to search players" });
    }
  }
);

/**
 * GET /admin/players/:id/wallets
 * All wallets for a player
 */
router.get(
  "/:id/wallets",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const userId = req.params.id;

      const wallets = await Wallet.findAll({
        where: { userId },
        order: [["currency", "ASC"]],
      });

      return res.json(wallets);
    } catch (err) {
      console.error("[ADMIN PLAYERS] GET /:id/wallets error:", err);
      return res.status(500).json({ error: "Failed to load wallets" });
    }
  }
);

/**
 * GET /admin/players/:id/transactions?limit=50
 * Transactions for all wallets of this player
 */
router.get(
  "/:id/transactions",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const userId = req.params.id;
      const limit = Math.min(
        parseInt(req.query.limit || "50", 10) || 50,
        200
      );

      const wallets = await Wallet.findAll({
        where: { userId },
        attributes: ["id"],
      });

      if (!wallets.length) {
        return res.json([]);
      }

      const walletIds = wallets.map((w) => w.id);

      const txs = await Transaction.findAll({
        where: { walletId: { [Op.in]: walletIds } },
        order: [["createdAt", "DESC"]],
        limit,
      });

      return res.json(txs);
    } catch (err) {
      console.error("[ADMIN PLAYERS] GET /:id/transactions error:", err);
      return res
        .status(500)
        .json({ error: "Failed to load player transactions" });
    }
  }
);

/**
 * GET /admin/players/:id/game-rounds?limit=50
 * Last game rounds for this player
 *
 * Assumes GameRound model exists with field userId.
 */
router.get(
  "/:id/game-rounds",
  requireAuth,
  requireRole("admin"),
  async (req, res) => {
    try {
      const userId = req.params.id;
      const limit = Math.min(
        parseInt(req.query.limit || "50", 10) || 50,
        200
      );

      if (!GameRound) {
        console.warn(
          "[ADMIN PLAYERS] GameRound model not defined; returning empty list."
        );
        return res.json([]);
      }

      const rounds = await GameRound.findAll({
        where: { userId },
        order: [["createdAt", "DESC"]],
        limit,
      });

      return res.json(rounds);
    } catch (err) {
      console.error("[ADMIN PLAYERS] GET /:id/game-rounds error:", err);
      return res
        .status(500)
        .json({ error: "Failed to load player game rounds" });
    }
  }
);

module.exports = router;
