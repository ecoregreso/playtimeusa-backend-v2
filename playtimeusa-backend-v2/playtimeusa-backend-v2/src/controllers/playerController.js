// src/controllers/playerController.js
const {
  loginPlayer,
  getPlayerState,
  acknowledgeBonus
} = require('../services/playerService');

async function loginHandler(req, res) {
  try {
    const { loginCode, pin } = req.body;
    const { token, player } = await loginPlayer({
      loginCode,
      pinPlain: pin
    });

    res.json({
      ok: true,
      token,
      player: {
        playerId: player.id,
        tenantId: player.tenantId,
        bonusAckRequired: player.bonusAckRequired
      }
    });
  } catch (err) {
    console.error('[loginHandler] error:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
}

async function getMeHandler(req, res) {
  try {
    const playerId = req.user.playerId;
    const state = await getPlayerState(playerId);
    res.json({ ok: true, state });
  } catch (err) {
    console.error('[getMeHandler] error:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
}

async function acknowledgeBonusHandler(req, res) {
  try {
    const playerId = req.user.playerId;
    await acknowledgeBonus(playerId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[acknowledgeBonusHandler] error:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
}

module.exports = {
  loginHandler,
  getMeHandler,
  acknowledgeBonusHandler
};
