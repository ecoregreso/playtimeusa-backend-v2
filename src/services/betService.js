// src/services/betService.js
const { sequelize, Player, Wallet, Bet, LedgerEntry } = require('../models');
const { checkAndTriggerBonus } = require('./voucherService');

function simulateOutcome(stakeMinor) {
  const r = Math.random();
  if (r < 0.1) {
    return {
      winMinor: stakeMinor * 5,
      outcome: 'WIN'
    };
  }
  return {
    winMinor: 0,
    outcome: 'LOSE'
  };
}

async function placeBet({ playerId, stakeMinor, gameCode }) {
  if (!stakeMinor || stakeMinor <= 0) {
    throw new Error('INVALID_STAKE');
  }
  if (!gameCode) {
    throw new Error('GAME_CODE_REQUIRED');
  }

  return sequelize.transaction(async (t) => {
    const player = await Player.findOne({
      where: { id: playerId },
      transaction: t
    });

    if (!player || player.status !== 'ACTIVE') {
      throw new Error('PLAYER_NOT_ACTIVE');
    }

    if (player.bonusAckRequired) {
      throw new Error('BONUS_ACK_REQUIRED');
    }

    const wallet = await Wallet.findOne({
      where: { ownerType: 'PLAYER', ownerId: player.id },
      transaction: t
    });

    if (!wallet) {
      throw new Error('PLAYER_WALLET_NOT_FOUND');
    }

    if (wallet.balanceMinor < stakeMinor) {
      throw new Error('INSUFFICIENT_BALANCE');
    }

    wallet.balanceMinor -= stakeMinor;

    const { winMinor, outcome } = simulateOutcome(stakeMinor);

    if (winMinor > 0) {
      wallet.balanceMinor += winMinor;
    }

    await wallet.save({ transaction: t });

    const bet = await Bet.create(
      {
        playerId: player.id,
        gameCode,
        stakeMinor,
        winMinor,
        outcome
      },
      { transaction: t }
    );

    await LedgerEntry.create(
      {
        fromWalletId: wallet.id,
        toWalletId: null,
        amountMinor: stakeMinor,
        type: 'BET_STAKE',
        refType: 'bet',
        refId: bet.id
      },
      { transaction: t }
    );

    if (winMinor > 0) {
      await LedgerEntry.create(
        {
          fromWalletId: null,
          toWalletId: wallet.id,
          amountMinor: winMinor,
          type: 'BET_WIN',
          refType: 'bet',
          refId: bet.id
        },
        { transaction: t }
      );
    }

    let bonusTriggered = false;

    const bonusResult = await checkAndTriggerBonus(player.id, t);
    if (bonusResult) {
      bonusTriggered = true;
      await wallet.reload({ transaction: t });
    }

    if (wallet.balanceMinor === 0) {
      player.status = 'CLOSED';
      await player.save({ transaction: t });
    }

    return {
      betId: bet.id,
      outcome,
      stakeMinor,
      winMinor,
      balanceMinor: wallet.balanceMinor,
      bonusTriggered
    };
  });
}

module.exports = {
  placeBet
};
