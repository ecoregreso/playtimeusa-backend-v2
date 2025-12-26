// src/routes/finance.js
const express = require("express");

const {
  DepositIntent,
  WithdrawalIntent,
  Wallet,
  Transaction,
} = require("../models");
const {
  staffAuth,
  requirePermission,
} = require("../middleware/staffAuth");
const { PERMISSIONS } = require("../constants/permissions");
const { buildRequestMeta, recordLedgerEvent, toCents } = require("../services/ledgerService");

const router = express.Router();

// GET /api/v1/deposits/admin/pending
router.get(
  "/deposits/admin/pending",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_READ),
  async (req, res) => {
    try {
      const intents = await DepositIntent.findAll({
        where: { status: "pending" },
        order: [["createdAt", "ASC"]],
      });

      res.json({
        ok: true,
        intents: intents.map((i) => ({
          id: i.id,
          amountFun: Number(i.amountFun || 0),
          address: i.address,
          expiresAt: i.expiresAt,
          userId: i.userId,
          status: i.status,
        })),
      });
    } catch (err) {
      console.error("[FINANCE] list deposits error:", err);
      res.status(500).json({ ok: false, error: "Failed to load deposits" });
    }
  }
);

// POST /api/v1/deposits/dev/mark-paid
router.post(
  "/deposits/dev/mark-paid",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_WRITE),
  async (req, res) => {
    try {
      const { intentId, txid } = req.body || {};
      const intent = await DepositIntent.findByPk(intentId);

      if (!intent) {
        return res.status(404).json({ ok: false, error: "Intent not found" });
      }

      if (intent.status === "credited") {
        return res.json({ ok: true, intent });
      }

      // Credit player wallet
      const wallet = await Wallet.findOne({ where: { userId: intent.userId } });
      if (wallet) {
        const before = Number(wallet.balance || 0);
        const amount = Number(intent.amountFun || 0);
        const after = before + amount;
        wallet.balance = after;
        await wallet.save();

        await Transaction.create({
          walletId: wallet.id,
          type: "credit",
          amount,
          balanceBefore: before,
          balanceAfter: after,
          reference: `deposit:${intent.id}`,
          metadata: { txid },
        });
      }

      intent.status = "credited";
      intent.confirmedAt = new Date();
      intent.creditedAt = new Date();
      intent.metadata = {
        ...(intent.metadata || {}),
        txid: txid || null,
        markedByStaffId: req.staff.id,
      };
      await intent.save();

      const staffMeta = buildRequestMeta(req, { staffRole: req.staff?.role || null });
      await recordLedgerEvent({
        ts: new Date(),
        playerId: intent.userId,
        cashierId: req.staff?.role === "cashier" ? req.staff.id : null,
        agentId: req.staff?.role === "cashier" ? null : req.staff?.id || null,
        eventType: "DEPOSIT",
        amountCents: toCents(intent.amountFun || 0),
        meta: {
          ...staffMeta,
          intentId: intent.id,
          provider: intent.provider,
          txid: txid || null,
        },
      });

      res.json({ ok: true, intent });
    } catch (err) {
      console.error("[FINANCE] mark deposit paid error:", err);
      res.status(500).json({ ok: false, error: "Failed to mark deposit" });
    }
  }
);

// GET /api/v1/withdrawals/admin/pending
router.get(
  "/withdrawals/admin/pending",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_READ),
  async (req, res) => {
    try {
      const intents = await WithdrawalIntent.findAll({
        where: { status: "pending" },
        order: [["createdAt", "ASC"]],
      });

      res.json({
        ok: true,
        intents: intents.map((i) => ({
          id: i.id,
          amountFun: Number(i.amountFun || 0),
          address: i.address,
          expiresAt: i.expiresAt,
          userId: i.userId,
          status: i.status,
        })),
      });
    } catch (err) {
      console.error("[FINANCE] list withdrawals error:", err);
      res.status(500).json({ ok: false, error: "Failed to load withdrawals" });
    }
  }
);

// POST /api/v1/withdrawals/dev/mark-sent
router.post(
  "/withdrawals/dev/mark-sent",
  staffAuth,
  requirePermission(PERMISSIONS.FINANCE_WRITE),
  async (req, res) => {
    try {
      const { intentId, txid } = req.body || {};
      const intent = await WithdrawalIntent.findByPk(intentId);

      if (!intent) {
        return res.status(404).json({ ok: false, error: "Intent not found" });
      }

      intent.status = "sent";
      intent.sentAt = new Date();
      intent.metadata = {
        ...(intent.metadata || {}),
        txid: txid || null,
        markedByStaffId: req.staff.id,
      };
      await intent.save();

      const staffMeta = buildRequestMeta(req, { staffRole: req.staff?.role || null });
      await recordLedgerEvent({
        ts: new Date(),
        playerId: intent.userId,
        cashierId: req.staff?.role === "cashier" ? req.staff.id : null,
        agentId: req.staff?.role === "cashier" ? null : req.staff?.id || null,
        eventType: "WITHDRAW",
        amountCents: toCents(-(intent.amountFun || 0)),
        meta: {
          ...staffMeta,
          intentId: intent.id,
          provider: intent.provider,
          txid: txid || null,
        },
      });

      res.json({ ok: true, intent });
    } catch (err) {
      console.error("[FINANCE] mark withdrawal sent error:", err);
      res.status(500).json({ ok: false, error: "Failed to mark withdrawal" });
    }
  }
);

module.exports = router;
