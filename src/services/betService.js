// src/services/betService.js
// Core bet engine for FunCoin spins

const { sequelize, Player, Bet } = require('../models');

/**
 * Safely coerce a value to an integer minor-unit amount.
 */
function toMinorInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  if (!Number.isInteger(n)) return NaN;
  return n;
}

/**
 * Place a bet for a player on a given game.
 *
 * Inputs:
 *   - playerId: UUID of the player
 *   - gameCode: string identifier for the game (e.g. "demo-slot-1")
 *   - wagerMinor: integer in minor units (1 = 0.01 FunCoin)
 *
 * Rules:
 *   - wagerMinor must be an integer
 *   - wagerMinor must be >= 1 (0.01 FunCoin)
 *   - wagerMinor must be <= player.balanceMinor
 */
async function placeBet({ playerId, gameCode, wagerMinor }) {
  if (!playerId) {
    throw new Error('PLAYER_REQUIRED');
  }

  if (!gameCode) {
    throw new Error('GAME_REQUIRED');
  }

  const stake = toMinorInt(wagerMinor);

  // Allow cent-level stakes: 1 minor unit = 0.01 FunCoin
  if (!Number.isInteger(stake) || stake < 1) {
    throw new Error('INVALID_STAKE');
  }

  return sequelize.transaction(async (t) => {
    // Lock & load player row for this transaction
    const player = await Player.findByPk(playerId, {
      transaction: t,
      lock: t.LOCK && t.LOCK.UPDATE ? t.LOCK.UPDATE : undefined,
    });

    if (!player) {
      throw new Error('PLAYER_NOT_FOUND');
    }

    if (stake > player.balanceMinor) {
      throw new Error('INSUFFICIENT_FUNDS');
    }

    const balanceBefore = player.balanceMinor;

    // --- Simple demo RNG logic ---
    // You can replace this later with a proper RTP-tuned engine.
    const WIN_CHANCE = 0.45;     // 45% of spins win something
    const MAX_MULTIPLIER = 5.0;  // up to 5x stake

    let payoutMinor = 0;
    let didWin = Math.random() < WIN_CHANCE;

    if (didWin) {
      // Random multiplier between 1x and MAX_MULTIPLIER (inclusive-ish), 2 decimal precision
      const rawMult = 1 + Math.random() * (MAX_MULTIPLIER - 1);
      const mult = Math.round(rawMult * 100) / 100;
      payoutMinor = Math.floor(stake * mult);
    }

    // Update player balance: subtract stake, add payout
    player.balanceMinor = player.balanceMinor - stake + payoutMinor;
    await player.save({ transaction: t });

    // Persist the bet record
    const bet = await Bet.create(
      {
        playerId: player.id,
        gameCode,
        wagerMinor: stake,
        payoutMinor,
      },
      { transaction: t }
    );

    // NOTE: jackpot + bonus progression can be plugged in here later

    return {
      betId: bet.id,
      playerId: player.id,
      gameCode,
      wagerMinor: stake,
      payoutMinor,
      balanceBeforeMinor: balanceBefore,
      balanceAfterMinor: player.balanceMinor,
      balanceMinor: player.balanceMinor, // alias for convenience
      bonusMovedMinor: 0,
      jackpotsHit: [],
    };
  });
}

module.exports = {
  placeBet,
};

