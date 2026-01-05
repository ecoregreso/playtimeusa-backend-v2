// src/routes/betRoutes.js
const express = require('express');
const router = express.Router();

const { requireStaffRole } = require('../middleware/staffAuth');
const db = require('../models');
const Bet = db.Bet; // If your Bet model is named differently adjust accordingly

// Ping
router.post('/ping', (req, res) => {
  res.json({
    ok: true,
    scope: 'bet',
    time: new Date().toISOString(),
    body: req.body
  });
});

// Player bet history (cashier can read)
router.get(
  '/player/:playerId',
  requireStaffRole(['cashier', 'agent', 'operator', 'owner']),
  async (req, res) => {
    try {
      const { playerId } = req.params;

      const logs = await Bet.findAll({
        where: { playerId },
        limit: 200,
        order: [['createdAt', 'DESC']]
      });

      res.json({ ok: true, logs });
    } catch (err) {
      console.error('[BET] history error:', err);
      res.status(500).json({ error: 'Failed to fetch bet history' });
    }
  }
);

// Query by playerCode
router.get(
  '/logs',
  requireStaffRole(['cashier', 'agent', 'operator', 'owner']),
  async (req, res) => {
    try {
      const { playerCode } = req.query;

      const logs = await Bet.findAll({
        where: { playerCode },
        limit: 200,
        order: [['createdAt', 'DESC']]
      });

      res.json({ ok: true, logs });
    } catch (err) {
      console.error('[BET] logs error:', err);
      res.status(500).json({ error: 'Failed to fetch logs' });
    }
  }
);

module.exports = router;
