// src/controllers/betController.js
const { placeBet } = require('../services/betService');

async function spinHandler(req, res) {
  try {
    const playerId = req.user.playerId;
    const { stakeMinor, gameCode } = req.body;

    const result = await placeBet({
      playerId,
      stakeMinor,
      gameCode
    });

    res.json({ ok: true, result });
  } catch (err) {
    console.error('[spinHandler] error:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
}

module.exports = {
  spinHandler
};
