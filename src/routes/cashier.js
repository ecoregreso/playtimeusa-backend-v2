// src/routes/cashier.js
const express = require('express');
const router = express.Router();
const { Voucher, Player } = require('../models');

function randomDigits(len) {
  return Math.floor(Math.random() * Math.pow(10, len))
    .toString()
    .padStart(len, '0');
}

// POST /api/cashier/voucher
// Creates a voucher with 50% bonus
router.post('/voucher', async (req, res) => {
  try {
    const { amount, createdBy } = req.body;

    const numericAmount = Number(amount);
    if (!numericAmount || isNaN(numericAmount) || numericAmount <= 0) {
      return res
        .status(400)
        .json({ error: 'amount must be a positive number' });
    }

    // 50% bonus logic
    const bonusAmount = +(numericAmount * 0.5).toFixed(2);
    const totalCredit = +(numericAmount + bonusAmount).toFixed(2);

    const code = randomDigits(6);
    const pin = randomDigits(6);

    const voucher = await Voucher.create({
      code,
      pin,
      amount: numericAmount,
      bonusAmount,
      totalCredit,
      createdBy: createdBy || 'system',
      status: 'NEW',
    });

    return res.status(201).json({
      id: voucher.id,
      code: voucher.code,
      pin: voucher.pin,
      amount: voucher.amount,
      bonusAmount: voucher.bonusAmount,
      totalCredit: voucher.totalCredit,
      status: voucher.status,
      createdAt: voucher.createdAt,
    });
  } catch (err) {
    console.error('[VOUCHER] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/cashier/redeem
// Redeems a voucher using code + pin, credits player balance, marks voucher as REDEEMED
router.post('/redeem', async (req, res) => {
  try {
    const { code, pin, playerId } = req.body;

    if (!code || !pin) {
      return res.status(400).json({ error: 'code and pin are required' });
    }

    if (!playerId) {
      return res.status(400).json({ error: 'playerId is required' });
    }

    const voucher = await Voucher.findOne({ where: { code, pin } });

    if (!voucher) {
      return res.status(404).json({ error: 'voucher_not_found' });
    }

    if (voucher.status === 'REDEEMED') {
      return res
        .status(400)
        .json({ error: 'voucher_already_redeemed' });
    }

    if (voucher.status === 'EXPIRED') {
      return res.status(400).json({ error: 'voucher_expired' });
    }

    // Find or create player by username = playerId for now
    const [player] = await Player.findOrCreate({
      where: { username: playerId },
      defaults: { balance: 0 },
    });

    const previousBalance = Number(player.balance);
    const credit = Number(voucher.totalCredit);
    const newBalance = +(previousBalance + credit).toFixed(2);

    player.balance = newBalance;
    await player.save();

    voucher.status = 'REDEEMED';
    voucher.redeemedBy = playerId;
    voucher.redeemedAt = new Date();
    await voucher.save();

    return res.status(200).json({
      voucher: {
        id: voucher.id,
        code: voucher.code,
        amount: voucher.amount,
        bonusAmount: voucher.bonusAmount,
        totalCredit: voucher.totalCredit,
        status: voucher.status,
        redeemedBy: voucher.redeemedBy,
        redeemedAt: voucher.redeemedAt,
      },
      player: {
        id: player.id,
        username: player.username,
        previousBalance,
        credited: credit,
        newBalance,
      },
    });
  } catch (err) {
    console.error('[VOUCHER REDEEM] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
