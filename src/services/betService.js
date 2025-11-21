// src/services/betService.js
// Core bet engine for FunCoin spins, using Wallet balances.

const { sequelize, Player, Wallet, Bet } = require('../models');

/**
 * Safely coerce a value to an integer minor-unit amount.
 * 1 minor unit = 0.01 FunCoin
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
 *   - wagerMinor must be <= wallet.balanceMinor
 */
async function placeBet({ playerId, gameCode, wagerMinor }) {
  if (!playerId) {
    throw new Error('PLAYER_REQUIRED');
  }

  if (!gameCode) {
    throw new Error('GAME_REQUIRED');
  }

  const stake = toMinorInt(wagerMinor);

  // DEBUG: see what the service thinks the stake is
  console.log('[BET_DEBUG_STAKE]', {
    raw: wagerMinor,
    parsed: stake,
    type: typeof wagerMinor,
  });

  // Allow cent-level stakes: 1 minor unit = 0.01 FunCoin
  if (!Number.isInteger(stake) || stake < 1) {
    throw new Error('INVALID_STAKE');
  }

  return sequelize.transaction(async (t) => {
    // Lock & load player
    const player = await Player.findByPk(playerId, {
      transaction: t,
      lock: t.LOCK && t.LOCK.UPDATE ? t.LOCK.UPDATE : undefined,
    });

    if (!player) {
      throw new Error('PLAYER_NOT_FOUND');
    }

    // Lock & load player's FUN wallet
    const wallet = await Wallet.findOne({
      where: {
        ownerType: 'PLAYER',
        ownerId: player.id,
        currency: 'FUN',
      },
      transaction: t,
      lock: t.LOCK && t.LOCK.UPDATE ? t.LOCK.UPDATE : undefined,
    });

    if (!wallet) {
      throw new Error('WALLET_NOT_FOUND');
    }

    if (stake > wallet.balanceMinor) {
      throw new Error('INSUFFICIENT_FUNDS');
    }

    const balanceBefore = wallet.balanceMinor;

    // --- Simple demo RNG logic ---
    const WIN_CHANCE = 0.45; // 45% of spins win something
    const MAX_MULTIPLIER = 5.0; // up to 5x stake

    let payoutMinor = 0;
    const didWin = Math.random() < WIN_CHANCE;

    if (didWin) {
      const rawMult = 1 + Math.random() * (MAX_MULTIPLIER - 1);
      const mult = Math.round(rawMult * 100) / 100;
      payoutMinor = Math.floor(stake * mult);
    }

    // Update wallet balance: subtract stake, add payout
    wallet.balanceMinor = wallet.balanceMinor - stake + payoutMinor;
    await wallet.save({ transaction: t });

    // Persist the bet record (schema uses stakeMinor + winMinor + outcome)
    const bet = await Bet.create(
      {
        playerId: player.id,
        gameCode,
        stakeMinor: stake,
        winMinor: payoutMinor,
        outcome: payoutMinor > 0 ? 'WIN' : 'LOSE',
      },
      { transaction: t }
    );

    return {
      betId: bet.id,
      playerId: player.id,
      gameCode,
      wagerMinor: stake,
      payoutMinor,
      balanceBeforeMinor: balanceBefore,
      balanceAfterMinor: wallet.balanceMinor,
      balanceMinor: wallet.balanceMinor,
      bonusMovedMinor: 0,
      jackpotsHit: [],
    };
  });
}

module.exports = {
  placeBet,
};


