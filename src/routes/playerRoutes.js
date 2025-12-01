const express = require('express');
const router = express.Router();

// Simple ping for debugging
router.get('/ping', (req, res) => {
  res.json({
    ok: true,
    scope: 'player',
    time: new Date().toISOString()
  });
});

// TEMP: list players for admin UI (stub)
// Later: replace this with real DB query (e.g. Player.findAll())
router.get('/', async (req, res) => {
  res.json([]);
});

module.exports = router;
