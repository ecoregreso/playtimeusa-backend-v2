// src/services/playerService.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { Player, Wallet, Bonus } = require('../models');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

async function loginPlayer({ loginCode, pinPlain }) {
  if (!loginCode || !pinPlain) {
    throw new Error('CODE_AND_PIN_REQUIRED');
  }

  const player = await Player.findOne({
    where: { loginCode }
  });

  if (!player || player.status !== 'ACTIVE') {
    throw new Error('INVALID_PLAYER_CREDENTIALS');
  }

  const ok = await bcrypt.compare(pinPlain, player.pinHash);
  if (!ok) {
    throw new Error('INVALID_PLAYER_CREDENTIALS');
  }

  const token = jwt.sign(
    {
      sub: player.id,
      role: 'player'
    },
    JWT_SECRET,
    { expiresIn: '12h' }
  );

  return { token, player };
}

async function getPlayerState(playerId) {
  const player = await Player.findByPk(playerId);
  if (!player) throw new Error('PLAYER_NOT_FOUND');

  const wallet = await Wallet.findOne({
    where: { ownerType: 'PLAYER', ownerId: player.id }
  });

  const bonus = await Bonus.findOne({
    where: { playerId: player.id, status: 'PENDING' }
  });

  return {
    playerId: player.id,
    tenantId: player.tenantId,
    balanceMinor: wallet ? wallet.balanceMinor : 0,
    bonusPendingMinor: bonus ? bonus.amountMinor : 0,
    bonusAckRequired: player.bonusAckRequired
  };
}

async function acknowledgeBonus(playerId) {
  const player = await Player.findByPk(playerId);
  if (!player) throw new Error('PLAYER_NOT_FOUND');

  player.bonusAckRequired = false;
  await player.save();

  return { ok: true };
}

module.exports = {
  loginPlayer,
  getPlayerState,
  acknowledgeBonus
};
