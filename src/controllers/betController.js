// src/controllers/betController.js
const { placeBet } = require('../services/betService');

async function spinHandler(req, res) {
  try {
    const playerId = req.user.playerId;

    // Support both "wagerMinor" (preferred) and legacy "stakeMinor"
    const { wagerMinor, stakeMinor, gameCode } = req.body;

    if (!gameCode) {
      return res.status(400).json({ ok: false, error: 'GAME_REQUIRED' });
    }

    const amountMinor =
      typeof wagerMinor !== 'undefined' ? wagerMinor : stakeMinor;

    const result = await placeBet({
      playerId,
      gameCode,
      wagerMinor: amountMinor,
    });

    res.json({ ok: true, result });
  } catch (err) {
    console.error('[spinHandler] error:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
}

module.exports = {
  spinHandler,
};

