const express = require('express');
const { Op } = require("sequelize");
const { sequelize } = require('../db');
const { User, Wallet, Transaction, Voucher } = require('../models');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logEvent } = require("../services/auditService");
const { resolveWalletVoucherPolicyState } = require("../services/voucherWalletStateService");
const { applyPendingBonusIfEligible, buildBonusState } = require("../services/bonusService");
const { resolveVoucherMaxCashout } = require("../services/voucherOutcomeService");
const { buildRequestMeta, recordLedgerEvent, toCents } = require("../services/ledgerService");
const { buildLimiter } = require("../utils/rateLimit");

const router = express.Router();
const walletVoucherRedeemLimiter = buildLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many voucher redeem attempts",
});

async function getOrCreateWallet(userId, tenantId, t) {
  let wallet = await Wallet.findOne({
    where: { userId, tenantId },
    transaction: t,
  });
  if (!wallet) {
    wallet = await Wallet.create(
      { userId, tenantId, balance: 0 },
      { transaction: t }
    );
  }
  return wallet;
}

function parseVoucherRedeemInput(rawCode, rawPin) {
  const codeRaw = String(rawCode || "").trim();
  const pinRaw = String(rawPin || "").trim();
  if (!codeRaw) return { code: "", pin: "" };
  if (pinRaw) return { code: codeRaw, pin: pinRaw };

  const parts = codeRaw.split(/[\s:|,;/\\-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return { code: String(parts[0] || "").trim(), pin: String(parts[1] || "").trim() };
  }
  return { code: codeRaw, pin: "" };
}

router.post(
  "/redeem-voucher",
  walletVoucherRedeemLimiter,
  requireAuth,
  requireRole("player"),
  async (req, res) => {
    const t = await sequelize.transaction({ transaction: req.transaction });
    try {
      const { code, pin } = parseVoucherRedeemInput(req.body?.code, req.body?.pin);
      const tenantId = req.auth?.tenantId || null;
      const userId = req.user?.id || null;

      if (!code) {
        await t.rollback();
        return res.status(400).json({ error: "code is required" });
      }
      if (!pin) {
        await t.rollback();
        return res.status(400).json({ error: "pin is required" });
      }
      if (!userId) {
        await t.rollback();
        return res.status(401).json({ error: "Unauthorized" });
      }

      const where = {
        tenantId,
        code: { [Op.iLike]: code },
        pin: { [Op.iLike]: pin },
        status: { [Op.in]: ["new", "NEW"] },
      };

      const voucher = await Voucher.findOne({
        where,
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      if (!voucher) {
        await t.rollback();
        return res.status(404).json({ error: "Voucher not found or already redeemed" });
      }

      if (voucher.expiresAt && new Date(voucher.expiresAt) < new Date()) {
        await t.rollback();
        return res.status(400).json({ error: "Voucher expired" });
      }

      const wallet = await getOrCreateWallet(userId, tenantId, t);
      const amount = Number(voucher.amount || 0);
      const bonus = Number(voucher.bonusAmount || 0);
      const before = Number(wallet.balance || 0);
      const maxCashout = resolveVoucherMaxCashout(voucher, amount + bonus);

      wallet.balance = before + amount;
      wallet.bonusPending = Number(wallet.bonusPending || 0) + bonus;
      wallet.activeVoucherId = voucher.id;
      await wallet.save({ transaction: t });

      const tx = await Transaction.create(
        {
          tenantId,
          walletId: wallet.id,
          type: "voucher_credit",
          amount,
          balanceBefore: before,
          balanceAfter: wallet.balance,
          reference: `voucher:${voucher.code}`,
          metadata: {
            voucherId: voucher.id,
            amount,
            bonusPending: bonus,
            maxCashout,
            activeVoucherId: voucher.id,
            source: "wallet.redeem-voucher",
          },
          createdByUserId: userId,
        },
        { transaction: t }
      );

      const priorPolicy =
        voucher.metadata &&
        voucher.metadata.voucherPolicy &&
        typeof voucher.metadata.voucherPolicy === "object"
          ? voucher.metadata.voucherPolicy
          : {};

      voucher.status = "redeemed";
      voucher.redeemedAt = new Date();
      voucher.redeemedByUserId = userId;
      voucher.maxCashout = maxCashout;
      voucher.metadata = {
        ...(voucher.metadata || {}),
        maxCashout,
        voucherPolicy: {
          ...priorPolicy,
          maxCashout,
          capReachedAt: priorPolicy.capReachedAt || null,
          decayMode: Boolean(priorPolicy.decayMode),
          decayRounds: Math.max(0, Number(priorPolicy.decayRounds || 0)),
          trackedBalance: Number(priorPolicy.trackedBalance || amount),
        },
      };
      await voucher.save({ transaction: t });

      await applyPendingBonusIfEligible({
        wallet,
        transaction: t,
        reference: `bonus:${voucher.code}`,
        metadata: { voucherId: voucher.id, source: "wallet.redeem-voucher" },
      });

      await t.commit();

      await recordLedgerEvent({
        ts: new Date(),
        playerId: userId,
        sessionId: req.headers["x-session-id"] ? String(req.headers["x-session-id"]) : null,
        actionId: voucher.id,
        eventType: "VOUCHER_REDEEMED",
        amountCents: toCents(amount + bonus),
        source: "wallet.redeem-voucher",
        meta: {
          ...buildRequestMeta(req),
          voucherId: voucher.id,
          amountCents: toCents(amount),
          bonusCents: toCents(bonus),
          maxCashoutCents: toCents(maxCashout),
        },
      });

      await logEvent({
        eventType: "VOUCHER_REDEEM",
        success: true,
        tenantId: tenantId || null,
        requestId: req.requestId,
        actorType: "user",
        actorId: userId,
        actorRole: req.user?.role || null,
        actorUsername: req.user?.username || null,
        route: req.originalUrl,
        method: req.method,
        statusCode: 200,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        meta: {
          voucherId: voucher.id,
          code: voucher.code,
          amount,
          bonus,
          maxCashout,
          source: "wallet.redeem-voucher",
        },
      });

      const voucherPolicy = await resolveWalletVoucherPolicyState({
        wallet,
        userId,
        tenantId: tenantId || wallet.tenantId || null,
        persistWalletLink: true,
      });

      return res.json({
        wallet,
        voucher,
        transaction: tx,
        bonus: buildBonusState(wallet),
        voucherPolicy,
      });
    } catch (err) {
      console.error("[WALLET] POST /redeem-voucher error:", err);
      if (!t.finished) {
        await t.rollback();
      }
      await logEvent({
        eventType: "VOUCHER_REDEEM",
        success: false,
        tenantId: req.auth?.tenantId || null,
        requestId: req.requestId,
        actorType: "user",
        actorId: req.user?.id || null,
        actorRole: req.user?.role || null,
        actorUsername: req.user?.username || null,
        route: req.originalUrl,
        method: req.method,
        statusCode: 500,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        meta: { reason: "exception", message: err.message, source: "wallet.redeem-voucher" },
      });
      return res.status(500).json({ error: "Failed to redeem voucher" });
    }
  }
);

router.get('/:userId',
  requireAuth,
  requireRole('admin', 'agent', 'cashier'),
  async (req, res) => {
    try {
      const { userId } = req.params;

      const wallet = await Wallet.findOne({
        where: { userId },
      });

      if (!wallet) {
        return res.status(404).json({ error: 'Wallet not found' });
      }

      const transactions = await Transaction.findAll({
        where: { walletId: wallet.id },
        order: [['createdAt', 'DESC']],
        limit: 50,
      });
      const voucherPolicy = await resolveWalletVoucherPolicyState({
        wallet,
        userId,
        tenantId: req.auth?.tenantId || wallet.tenantId || null,
        persistWalletLink: true,
      });

      return res.json({
        wallet,
        voucherPolicy,
        transactions,
      });
    } catch (err) {
      console.error('[WALLET] GET /wallets/:userId error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post('/:userId/credit',
  requireAuth,
  requireRole('admin', 'agent', 'cashier'),
  async (req, res) => {
    const t = await sequelize.transaction({ transaction: req.transaction });
    try {
      const { userId } = req.params;
      const { amount, type = 'credit', reference, metadata } = req.body;

      const numericAmount = parseFloat(amount);
      if (!numericAmount || numericAmount <= 0) {
        await t.rollback();
        await logEvent({
          eventType: "WALLET_ADJUST",
          success: false,
          tenantId: req.auth?.tenantId || null,
          requestId: req.requestId,
          actorType: "user",
          actorId: req.user?.id || null,
          actorRole: req.user?.role || null,
          actorUsername: req.user?.username || null,
          route: req.originalUrl,
          method: req.method,
          statusCode: 400,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          meta: { reason: "invalid_amount", direction: "credit", amount },
        });
        return res.status(400).json({ error: 'amount must be > 0' });
      }

      const user = await User.findByPk(userId, { transaction: t });
      if (!user) {
        await t.rollback();
        await logEvent({
          eventType: "WALLET_ADJUST",
          success: false,
          tenantId: req.auth?.tenantId || null,
          requestId: req.requestId,
          actorType: "user",
          actorId: req.user?.id || null,
          actorRole: req.user?.role || null,
          actorUsername: req.user?.username || null,
          route: req.originalUrl,
          method: req.method,
          statusCode: 404,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          meta: { reason: "user_not_found", direction: "credit", targetUserId: userId },
        });
        return res.status(404).json({ error: 'User not found' });
      }

      const wallet = await getOrCreateWallet(userId, req.auth?.tenantId || null, t);

      const balanceBefore = parseFloat(wallet.balance);
      const balanceAfter = balanceBefore + numericAmount;

      wallet.balance = balanceAfter;
      await wallet.save({ transaction: t });

      const tx = await Transaction.create({
        tenantId: req.auth?.tenantId || null,
        walletId: wallet.id,
        type,
        amount: numericAmount,
        balanceBefore,
        balanceAfter,
        reference: reference || null,
        metadata: metadata || null,
        createdByUserId: req.user.id,
      }, { transaction: t });

      await t.commit();

      await logEvent({
        eventType: "WALLET_ADJUST",
        success: true,
        tenantId: req.auth?.tenantId || null,
        requestId: req.requestId,
        actorType: "user",
        actorId: req.user?.id || null,
        actorRole: req.user?.role || null,
        actorUsername: req.user?.username || null,
        route: req.originalUrl,
        method: req.method,
        statusCode: 201,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        meta: {
          direction: "credit",
          amount: numericAmount,
          type,
          reference,
          targetUserId: userId,
          transactionId: tx?.id || null,
        },
      });
      const voucherPolicy = await resolveWalletVoucherPolicyState({
        wallet,
        userId,
        tenantId: req.auth?.tenantId || wallet.tenantId || null,
      });

      return res.status(201).json({
        wallet,
        voucherPolicy,
        transaction: tx,
      });
    } catch (err) {
      console.error('[WALLET] POST /wallets/:userId/credit error:', err);
      await t.rollback();
      await logEvent({
        eventType: "WALLET_ADJUST",
        success: false,
        tenantId: req.auth?.tenantId || null,
        requestId: req.requestId,
        actorType: "user",
        actorId: req.user?.id || null,
        actorRole: req.user?.role || null,
        actorUsername: req.user?.username || null,
        route: req.originalUrl,
        method: req.method,
        statusCode: 500,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        meta: { reason: "exception", direction: "credit", message: err.message },
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post('/:userId/debit',
  requireAuth,
  requireRole('admin', 'agent', 'cashier'),
  async (req, res) => {
    const t = await sequelize.transaction({ transaction: req.transaction });
    try {
      const { userId } = req.params;
      const { amount, type = 'debit', reference, metadata } = req.body;

      const numericAmount = parseFloat(amount);
      if (!numericAmount || numericAmount <= 0) {
        await t.rollback();
        await logEvent({
          eventType: "WALLET_ADJUST",
          success: false,
          tenantId: req.auth?.tenantId || null,
          requestId: req.requestId,
          actorType: "user",
          actorId: req.user?.id || null,
          actorRole: req.user?.role || null,
          actorUsername: req.user?.username || null,
          route: req.originalUrl,
          method: req.method,
          statusCode: 400,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          meta: { reason: "invalid_amount", direction: "debit", amount },
        });
        return res.status(400).json({ error: 'amount must be > 0' });
      }

      const user = await User.findByPk(userId, { transaction: t });
      if (!user) {
        await t.rollback();
        await logEvent({
          eventType: "WALLET_ADJUST",
          success: false,
          tenantId: req.auth?.tenantId || null,
          requestId: req.requestId,
          actorType: "user",
          actorId: req.user?.id || null,
          actorRole: req.user?.role || null,
          actorUsername: req.user?.username || null,
          route: req.originalUrl,
          method: req.method,
          statusCode: 404,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          meta: { reason: "user_not_found", direction: "debit", targetUserId: userId },
        });
        return res.status(404).json({ error: 'User not found' });
      }

      const wallet = await getOrCreateWallet(userId, req.auth?.tenantId || null, t);

      const balanceBefore = parseFloat(wallet.balance);
      if (balanceBefore < numericAmount) {
        await t.rollback();
        await logEvent({
          eventType: "WALLET_ADJUST",
          success: false,
          tenantId: req.auth?.tenantId || null,
          requestId: req.requestId,
          actorType: "user",
          actorId: req.user?.id || null,
          actorRole: req.user?.role || null,
          actorUsername: req.user?.username || null,
          route: req.originalUrl,
          method: req.method,
          statusCode: 400,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          meta: { reason: "insufficient_funds", direction: "debit", amount: numericAmount },
        });
        return res.status(400).json({ error: 'Insufficient funds' });
      }

      const balanceAfter = balanceBefore - numericAmount;

      wallet.balance = balanceAfter;
      await wallet.save({ transaction: t });

      const tx = await Transaction.create({
        tenantId: req.auth?.tenantId || null,
        walletId: wallet.id,
        type,
        amount: numericAmount,
        balanceBefore,
        balanceAfter,
        reference: reference || null,
        metadata: metadata || null,
        createdByUserId: req.user.id,
      }, { transaction: t });

      await t.commit();

      await logEvent({
        eventType: "WALLET_ADJUST",
        success: true,
        tenantId: req.auth?.tenantId || null,
        requestId: req.requestId,
        actorType: "user",
        actorId: req.user?.id || null,
        actorRole: req.user?.role || null,
        actorUsername: req.user?.username || null,
        route: req.originalUrl,
        method: req.method,
        statusCode: 201,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        meta: {
          direction: "debit",
          amount: numericAmount,
          type,
          reference,
          targetUserId: userId,
          transactionId: tx?.id || null,
        },
      });
      const voucherPolicy = await resolveWalletVoucherPolicyState({
        wallet,
        userId,
        tenantId: req.auth?.tenantId || wallet.tenantId || null,
      });

      return res.status(201).json({
        wallet,
        voucherPolicy,
        transaction: tx,
      });
    } catch (err) {
      console.error('[WALLET] POST /wallets/:userId/debit error:', err);
      await t.rollback();
      await logEvent({
        eventType: "WALLET_ADJUST",
        success: false,
        tenantId: req.auth?.tenantId || null,
        requestId: req.requestId,
        actorType: "user",
        actorId: req.user?.id || null,
        actorRole: req.user?.role || null,
        actorUsername: req.user?.username || null,
        route: req.originalUrl,
        method: req.method,
        statusCode: 500,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        meta: { reason: "exception", direction: "debit", message: err.message },
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
