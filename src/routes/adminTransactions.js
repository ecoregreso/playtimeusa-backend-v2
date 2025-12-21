// src/routes/adminTransactions.js
const express = require("express");
const { Op } = require("sequelize");

const { Transaction, Wallet } = require("../models");
const {
  staffAuth,
  requirePermission,
} = require("../middleware/staffAuth");
const { PERMISSIONS } = require("../constants/permissions");

const router = express.Router();

// GET /api/v1/admin/transactions
router.get(
  "/",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_READ),
  async (req, res) => {
    try {
      const { type, userId } = req.query;
      const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);
      const from = req.query.from ? new Date(req.query.from) : null;
      const to = req.query.to ? new Date(req.query.to) : null;

      const where = {};
      if (type) where.type = type;

      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt[Op.gte] = from;
        if (to) {
          const end = new Date(to);
          end.setDate(end.getDate() + 1);
          where.createdAt[Op.lt] = end;
        }
      }

      const include = [];
      if (userId) {
        include.push({
          model: Wallet,
          as: "wallet",
          required: true,
          where: { userId },
        });
      } else {
        include.push({ model: Wallet, as: "wallet" });
      }

      const transactions = await Transaction.findAll({
        where,
        include,
        order: [["createdAt", "DESC"]],
        limit,
      });

      res.json({ ok: true, transactions });
    } catch (err) {
      console.error("[ADMIN_TX] list error:", err);
      res.status(500).json({ ok: false, error: "Failed to list transactions" });
    }
  }
);

module.exports = router;
