const express = require('express');
const { sequelize } = require('../db');
const { User, Wallet, Transaction } = require('../models');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logEvent } = require("../services/auditService");
const { resolveWalletVoucherPolicyState } = require("../services/voucherWalletStateService");

const router = express.Router();

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
