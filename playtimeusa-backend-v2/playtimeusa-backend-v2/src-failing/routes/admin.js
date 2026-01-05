// src/routes/admin.js
const express = require('express');
const router = express.Router();
const { Player, Voucher } = require('../models');
const { authAdmin, requireRole } = require('../middleware/adminAuth');

// All routes here require a valid admin token
router.use(authAdmin);

// Only full ADMIN for now
const onlyAdmin = requireRole('ADMIN');

// GET /api/admin/players
router.get('/players', onlyAdmin, async (req, res) => {
  try {
    const players = await Player.findAll({
      order: [['created_at', 'DESC']],
      limit: 100,
    });

    return res.json({ players });
  } catch (err) {
    console.error('[ADMIN PLAYERS] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/admin/players/:username
router.get('/players/:username', onlyAdmin, async (req, res) => {
  try {
    const { username } = req.params;
    const player = await Player.findOne({ where: { username } });

    if (!player) {
      return res.status(404).json({ error: 'player_not_found' });
    }

    return res.json({ player });
  } catch (err) {
    console.error('[ADMIN PLAYER DETAIL] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// GET /api/admin/vouchers?status=NEW|REDEEMED|EXPIRED
router.get('/vouchers', onlyAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const where = {};

    if (status) {
      where.status = status;
    }

    const vouchers = await Voucher.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: 200,
    });

    return res.json({ vouchers });
  } catch (err) {
    console.error('[ADMIN VOUCHERS] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;

