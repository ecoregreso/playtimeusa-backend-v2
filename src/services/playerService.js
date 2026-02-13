const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { Player, Wallet, Bonus } = require('../models');
const { signAccessToken, signRefreshToken } = require('../utils/jwt');
const { hashToken } = require('../utils/token');
const { RefreshToken } = require('../models');
const { getLock, recordFailure, recordSuccess } = require('../utils/lockout');

const REFRESH_DAYS = 7;

async function loginPlayer({ loginCode, pinPlain, req }) {
  if (!loginCode || !pinPlain) {
    throw new Error('CODE_AND_PIN_REQUIRED');
  }

  const lock = await getLock('player', loginCode, null);
  if (lock.locked) {
    const err = new Error('LOCKED');
    err.lockUntil = lock.lockUntil;
    throw err;
  }

  const player = await Player.findOne({
    where: { loginCode }
  });

  if (!player || player.status !== 'ACTIVE') {
    await recordFailure({ subjectType: 'player', subjectId: loginCode, ip: req?.ip, userAgent: req?.get?.('user-agent') });
    throw new Error('INVALID_PLAYER_CREDENTIALS');
  }

  const ok = await bcrypt.compare(pinPlain, player.pinHash);
  if (!ok) {
    await recordFailure({ subjectType: 'player', subjectId: loginCode, ip: req?.ip, userAgent: req?.get?.('user-agent') });
    throw new Error('INVALID_PLAYER_CREDENTIALS');
  }

  await recordSuccess({ subjectType: 'player', subjectId: loginCode });

  const accessJti = uuidv4();
  const refreshJti = uuidv4();
  const accessToken = signAccessToken(player, { jti: accessJti });
  const refreshToken = signRefreshToken(player, { jti: refreshJti });
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000);
  await RefreshToken.create({
    id: refreshJti,
    userId: player.id,
    tenantId: player.tenantId,
    role: 'player',
    hashedToken: hashToken(refreshToken),
    expiresAt,
  });

  return { token: accessToken, refreshToken, player };
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
