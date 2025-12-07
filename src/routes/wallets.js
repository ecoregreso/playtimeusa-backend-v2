const express = require('express');
const { sequelize } = require('../db');
const { User, Wallet, Transaction } = require('../models');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

async function getOrCreateWallet(userId, t) {
  let wallet = await Wallet.findOne({ where: { userId }, transaction: t });
  if (!wallet) {
    wallet = await Wallet.create({ userId, balance: 0 }, { transaction: t });
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

      return res.json({
        wallet,
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
    const t = await sequelize.transaction();
    try {
      const { userId } = req.params;
      const { amount, type = 'credit', reference, metadata } = req.body;

      const numericAmount = parseFloat(amount);
      if (!numericAmount || numericAmount <= 0) {
        await t.rollback();
        return res.status(400).json({ error: 'amount must be > 0' });
      }

      const user = await User.findByPk(userId, { transaction: t });
      if (!user) {
        await t.rollback();
        return res.status(404).json({ error: 'User not found' });
      }

      const wallet = await getOrCreateWallet(userId, t);

      const balanceBefore = parseFloat(wallet.balance);
      const balanceAfter = balanceBefore + numericAmount;

      wallet.balance = balanceAfter;
      await wallet.save({ transaction: t });

      const tx = await Transaction.create({
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

      return res.status(201).json({
        wallet,
        transaction: tx,
      });
    } catch (err) {
      console.error('[WALLET] POST /wallets/:userId/credit error:', err);
      await t.rollback();
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post('/:userId/debit',
  requireAuth,
  requireRole('admin', 'agent', 'cashier'),
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const { userId } = req.params;
      const { amount, type = 'debit', reference, metadata } = req.body;

      const numericAmount = parseFloat(amount);
      if (!numericAmount || numericAmount <= 0) {
        await t.rollback();
        return res.status(400).json({ error: 'amount must be > 0' });
      }

      const user = await User.findByPk(userId, { transaction: t });
      if (!user) {
        await t.rollback();
        return res.status(404).json({ error: 'User not found' });
      }

      const wallet = await getOrCreateWallet(userId, t);

      const balanceBefore = parseFloat(wallet.balance);
      if (balanceBefore < numericAmount) {
        await t.rollback();
        return res.status(400).json({ error: 'Insufficient funds' });
      }

      const balanceAfter = balanceBefore - numericAmount;

      wallet.balance = balanceAfter;
      await wallet.save({ transaction: t });

      const tx = await Transaction.create({
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

      return res.status(201).json({
        wallet,
        transaction: tx,
      });
    } catch (err) {
      console.error('[WALLET] POST /wallets/:userId/debit error:', err);
      await t.rollback();
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
