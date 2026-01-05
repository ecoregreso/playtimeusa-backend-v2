#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

TS="$(date +%s)"
[[ -f src/routes/wallets.js ]] && cp src/routes/wallets.js "src/routes/wallets.js.bak.$TS" && echo "[backup] src/routes/wallets.js.bak.$TS"

cat > src/routes/wallets.js <<'JS'
const express = require("express");
const { sequelize } = require("../models");
const { User, Wallet, Transaction } = require("../models");
const { requireAuth, requireRole, requireSessionHeader } = require("../middleware/auth");

const router = express.Router();

async function getOrCreateWallet(userId, currency, t) {
  const cur = (currency || "FUN").toUpperCase();
  let wallet = await Wallet.findOne({
    where: { userId, currency: cur },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!wallet) wallet = await Wallet.create({ userId, currency: cur, balance: 0 }, { transaction: t });
  return wallet;
}

function actorFromReq(req) {
  const u = req.user || {};
  const actorType = u.actorType || "user";
  const actorId = u.id || null;
  const sid = u.sid || null;
  return { actorType, actorId, sid };
}

function txAttribution(req, extraMetadata = {}) {
  const { actorType, actorId, sid } = actorFromReq(req);

  // IMPORTANT:
  // transactions.createdByUserId is UUID (users table). Staff IDs are integers (staff_users).
  // Therefore: for staff actions createdByUserId MUST be null, and staff attribution goes to metadata.
  if (actorType === "staff") {
    return {
      createdByUserId: null,
      metadata: {
        ...extraMetadata,
        sessionId: sid,
        createdByActorType: "staff",
        createdByStaffId: actorId,
      },
    };
  }

  return {
    createdByUserId: actorId,
    metadata: {
      ...extraMetadata,
      sessionId: sid,
      createdByActorType: "user",
    },
  };
}

// GET /api/v1/wallets  (current authenticated player's wallets)
router.get("/", requireAuth, requireRole("player"), async (req, res) => {
  try {
    const wallets = await Wallet.findAll({ where: { userId: req.user.id } });
    return res.json({ ok: true, wallets });
  } catch (err) {
    console.error("[WALLETS] list self error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/v1/wallets/:userId  (staff view)
router.get(
  "/:userId",
  requireAuth,
  requireRole("owner", "operator", "admin", "agent", "cashier"),
  async (req, res) => {
    try {
      const { userId } = req.params;

      const wallets = await Wallet.findAll({ where: { userId } });
      if (!wallets || wallets.length === 0) return res.status(404).json({ error: "Wallet not found" });

      const walletIds = wallets.map((w) => w.id);

      const transactions = await Transaction.findAll({
        where: { walletId: walletIds },
        order: [["createdAt", "DESC"]],
        limit: 50,
      });

      return res.json({ wallets, transactions });
    } catch (err) {
      console.error("[WALLETS] GET /wallets/:userId error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /api/v1/wallets/:userId/credit (staff)
router.post(
  "/:userId/credit",
  requireAuth,
  requireRole("owner", "operator", "admin", "agent", "cashier"),
  requireSessionHeader,
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const { userId } = req.params;
      const { amount, currency = "FUN", reference, metadata, subtype } = req.body || {};

      const numericAmount = Number(amount);
      if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        await t.rollback();
        return res.status(400).json({ error: "amount must be > 0" });
      }

      const user = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!user) {
        await t.rollback();
        return res.status(404).json({ error: "User not found" });
      }

      const wallet = await getOrCreateWallet(userId, currency, t);

      const balanceBefore = Number(wallet.balance || 0);
      const balanceAfter = balanceBefore + numericAmount;

      wallet.balance = balanceAfter;
      await wallet.save({ transaction: t });

      const attrib = txAttribution(req, {
        ...(metadata || {}),
        subtype: subtype || "manual_credit",
      });

      const tx = await Transaction.create(
        {
          walletId: wallet.id,
          type: "credit",
          amount: numericAmount,
          balanceBefore,
          balanceAfter,
          reference: reference || null,
          metadata: attrib.metadata,
          createdByUserId: attrib.createdByUserId,
        },
        { transaction: t }
      );

      await t.commit();
      return res.status(201).json({ wallet, transaction: tx });
    } catch (err) {
      console.error("[WALLETS] POST /wallets/:userId/credit error:", err);
      await t.rollback();
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /api/v1/wallets/:userId/debit (staff)
router.post(
  "/:userId/debit",
  requireAuth,
  requireRole("owner", "operator", "admin", "agent", "cashier"),
  requireSessionHeader,
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const { userId } = req.params;
      const { amount, currency = "FUN", reference, metadata, subtype } = req.body || {};

      const numericAmount = Number(amount);
      if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        await t.rollback();
        return res.status(400).json({ error: "amount must be > 0" });
      }

      const user = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!user) {
        await t.rollback();
        return res.status(404).json({ error: "User not found" });
      }

      const wallet = await getOrCreateWallet(userId, currency, t);

      const balanceBefore = Number(wallet.balance || 0);
      if (balanceBefore < numericAmount) {
        await t.rollback();
        return res.status(400).json({ error: "Insufficient funds" });
      }

      const balanceAfter = balanceBefore - numericAmount;

      wallet.balance = balanceAfter;
      await wallet.save({ transaction: t });

      const attrib = txAttribution(req, {
        ...(metadata || {}),
        subtype: subtype || "manual_debit",
      });

      const tx = await Transaction.create(
        {
          walletId: wallet.id,
          type: "debit",
          amount: numericAmount,
          balanceBefore,
          balanceAfter,
          reference: reference || null,
          metadata: attrib.metadata,
          createdByUserId: attrib.createdByUserId,
        },
        { transaction: t }
      );

      await t.commit();
      return res.status(201).json({ wallet, transaction: tx });
    } catch (err) {
      console.error("[WALLETS] POST /wallets/:userId/debit error:", err);
      await t.rollback();
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = router;
JS

echo "[ok] wallets.js now prevents staff integer IDs from being written into transactions.createdByUserId (UUID)"
