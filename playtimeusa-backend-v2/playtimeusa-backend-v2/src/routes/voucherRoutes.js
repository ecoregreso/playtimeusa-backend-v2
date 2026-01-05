// src/routes/voucherRoutes.js
const express = require('express');
const router = express.Router();

// Use the models index so we get the initialized Sequelize models
const db = require('../models');
const Voucher = db.Voucher;

const { requireStaffRole } = require('../middleware/staffAuth');

// Simple ping for debugging this route group
router.get('/ping', (req, res) => {
  res.json({
    ok: true,
    scope: 'voucher',
    time: new Date().toISOString(),
  });
});

// Helper to generate a readable random voucher code
function generateVoucherCode(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

// GET /api/v1/voucher
// List vouchers – agent/operator/owner only
router.get(
  '/',
  requireStaffRole(['agent', 'operator', 'owner']),
  async (req, res) => {
    try {
      const vouchers = await Voucher.findAll({
        order: [['createdAt', 'DESC']],
        limit: 200,
      });

      res.json(vouchers);
    } catch (err) {
      console.error('[VOUCHER] list error:', err);
      res
        .status(500)
        .json({ error: 'Failed to list vouchers', detail: err.message });
    }
  }
);

// POST /api/v1/voucher
// Create voucher – cashier and above
router.post(
  '/',
  requireStaffRole(['cashier', 'agent', 'operator', 'owner']),
  async (req, res) => {
    try {
      let { amount, bonus, createdBy } = req.body;

      amount = parseFloat(amount);
      bonus = bonus != null ? parseFloat(bonus) : 0;

      if (!Number.isFinite(amount) || amount <= 0) {
        return res
          .status(400)
          .json({ error: 'amount must be a positive number' });
      }
      if (!Number.isFinite(bonus) || bonus < 0) {
        return res.status(400).json({ error: 'bonus must be >= 0' });
      }

      const code = generateVoucherCode(10);

      const voucher = await Voucher.create({
        code,
        amount,
        bonus,
        status: 'new',
        createdBy: createdBy || (req.staff ? req.staff.username : 'system'),
      });

      res.status(201).json(voucher);
    } catch (err) {
      console.error('[VOUCHER] create error:', err);
      res
        .status(500)
        .json({ error: 'Failed to create voucher', detail: err.message });
    }
  }
);

// POST /api/v1/voucher/redeem
// Redeem voucher – cashier and above
router.post(
  '/redeem',
  requireStaffRole(['cashier', 'agent', 'operator', 'owner']),
  async (req, res) => {
    try {
      const { code, userCode } = req.body;

      if (!code) {
        return res.status(400).json({ error: 'code is required' });
      }

      const voucher = await Voucher.findOne({ where: { code } });

      if (!voucher) {
        return res.status(404).json({ error: 'Voucher not found' });
      }

      if (voucher.status !== 'new' && voucher.status !== 'active') {
        return res.status(400).json({
          error: 'Voucher is not redeemable',
          status: voucher.status,
        });
      }

      voucher.status = 'redeemed';
      voucher.redeemedBy = userCode || null;
      voucher.redeemedAt = new Date();

      await voucher.save();

      res.json({
        ok: true,
        voucher,
      });
    } catch (err) {
      console.error('[VOUCHER] redeem error:', err);
      res
        .status(500)
        .json({ error: 'Failed to redeem voucher', detail: err.message });
    }
  }
);

module.exports = router;
