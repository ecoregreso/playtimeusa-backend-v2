// src/services/voucherService.js
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const {
  sequelize,
  Tenant,
  Wallet,
  Voucher,
  Player,
  Bonus,
  LedgerEntry
} = require('../models');

const BONUS_PERCENT = 50;
const BONUS_TRIGGER_BALANCE = 100;

function randomDigits(len) {
  let s = '';
  while (s.length < len) {
    s += Math.floor(Math.random() * 10).toString();
  }
  return s.slice(0, len);
}

function generateVoucherCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

async function hashPin(pin) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(pin, salt);
}

async function verifyPin(pin, hash) {
  return bcrypt.compare(pin, hash);
}

async function getOrCreateWallet(ownerType, ownerId, currency, transaction) {
  const currencyCode = currency || 'FUN';
  let wallet = await Wallet.findOne({
    where: { ownerType, ownerId, currency: currencyCode },
    transaction
  });
  if (!wallet) {
    wallet = await Wallet.create(
      {
        ownerType,
        ownerId,
        currency: currencyCode,
        balanceMinor: 0
      },
      { transaction }
    );
  }
  return wallet;
}

async function issueVoucher({ agentTenantId, amountMinor, prizeWheelEnabled }) {
  if (!amountMinor || amountMinor <= 0) {
    throw new Error('INVALID_AMOUNT');
  }

  return sequelize.transaction(async (t) => {
    const agent = await Tenant.findOne({
      where: { id: agentTenantId, type: 'AGENT', status: 'ACTIVE' },
      transaction: t
    });

    if (!agent) {
      throw new Error('INVALID_AGENT');
    }

    const agentWallet = await getOrCreateWallet(
      'TENANT',
      agent.id,
      'FUN',
      t
    );

    const bonusAmountMinor = Math.floor(
      amountMinor * (BONUS_PERCENT / 100)
    );
    const totalCostMinor = amountMinor + bonusAmountMinor;

    if (agentWallet.balanceMinor < totalCostMinor) {
      throw new Error('INSUFFICIENT_AGENT_FUNCOIN');
    }

    agentWallet.balanceMinor -= totalCostMinor;
    await agentWallet.save({ transaction: t });

    const voucherCode = generateVoucherCode();
    const pinPlain = randomDigits(6);
    const pinHash = await hashPin(pinPlain);

    const voucher = await Voucher.create(
      {
        tenantId: agent.id,
        code: voucherCode,
        pinHash,
        amountMinor,
        bonusAmountMinor,
        totalCostMinor,
        prizeWheelEnabled: !!prizeWheelEnabled
      },
      { transaction: t }
    );

    await LedgerEntry.create(
      {
        fromWalletId: agentWallet.id,
        toWalletId: null,
        amountMinor: totalCostMinor,
        type: 'TENANT_VOUCHER_PACKAGE_FUND',
        refType: 'voucher',
        refId: voucher.id
      },
      { transaction: t }
    );

    return {
      voucherId: voucher.id,
      code: voucher.code,
      pin: pinPlain,
      amountMinor,
      bonusAmountMinor
    };
  });
}

async function redeemVoucher({ code, pinPlain }) {
  if (!code || !pinPlain) {
    throw new Error('CODE_AND_PIN_REQUIRED');
  }

  return sequelize.transaction(async (t) => {
    const voucher = await Voucher.findOne({
      where: { code },
      transaction: t,
      lock: t.LOCK && t.LOCK.UPDATE
    });

    if (!voucher || voucher.status !== 'NEW') {
      throw new Error('INVALID_OR_USED_VOUCHER');
    }

    const pinOk = await verifyPin(pinPlain, voucher.pinHash);
    if (!pinOk) {
      throw new Error('INVALID_VOUCHER_PIN');
    }

    const loginCode = randomDigits(6);
    const playerPin = randomDigits(6);
    const playerPinHash = await hashPin(playerPin);

    const player = await Player.create(
      {
        tenantId: voucher.tenantId,
        loginCode,
        pinHash: playerPinHash,
        status: 'ACTIVE'
      },
      { transaction: t }
    );

    const playerWallet = await getOrCreateWallet(
      'PLAYER',
      player.id,
      'FUN',
      t
    );

    voucher.status = 'USED';
    voucher.playerUsedId = player.id;
    await voucher.save({ transaction: t });

    playerWallet.balanceMinor += voucher.amountMinor;
    await playerWallet.save({ transaction: t });

    await LedgerEntry.create(
      {
        fromWalletId: null,
        toWalletId: playerWallet.id,
        amountMinor: voucher.amountMinor,
        type: 'VOUCHER_REDEEM',
        refType: 'voucher',
        refId: voucher.id
      },
      { transaction: t }
    );

    const bonus = await Bonus.create(
      {
        playerId: player.id,
        walletId: playerWallet.id,
        sourceVoucherId: voucher.id,
        amountMinor: voucher.bonusAmountMinor,
        triggerBalanceMinor: BONUS_TRIGGER_BALANCE,
        status: 'PENDING'
      },
      { transaction: t }
    );

    return {
      playerId: player.id,
      loginCode,
      pin: playerPin,
      walletId: playerWallet.id,
      balanceMinor: playerWallet.balanceMinor,
      bonusAmountMinor: bonus.amountMinor,
      prizeWheelEnabled: voucher.prizeWheelEnabled
    };
  });
}

async function checkAndTriggerBonus(playerId, transaction) {
  const t = transaction;

  const player = await Player.findOne({
    where: { id: playerId, status: 'ACTIVE' },
    transaction: t
  });

  if (!player) return null;

  const wallet = await Wallet.findOne({
    where: { ownerType: 'PLAYER', ownerId: player.id },
    transaction: t
  });

  if (!wallet) return null;

  const bonus = await Bonus.findOne({
    where: {
      playerId: player.id,
      walletId: wallet.id,
      status: 'PENDING'
    },
    transaction: t
  });

  if (!bonus) return null;

  if (wallet.balanceMinor > bonus.triggerBalanceMinor) {
    return null;
  }

  wallet.balanceMinor += bonus.amountMinor;
  await wallet.save({ transaction: t });

  bonus.status = 'TRIGGERED';
  bonus.triggeredAt = new Date();
  await bonus.save({ transaction: t });

  await LedgerEntry.create(
    {
      fromWalletId: null,
      toWalletId: wallet.id,
      amountMinor: bonus.amountMinor,
      type: 'BONUS_CREDIT',
      refType: 'bonus',
      refId: bonus.id
    },
    { transaction: t }
  );

  player.bonusAckRequired = true;
  await player.save({ transaction: t });

  return {
    newBalanceMinor: wallet.balanceMinor,
    bonusAmountMinor: bonus.amountMinor
  };
}

module.exports = {
  issueVoucher,
  redeemVoucher,
  checkAndTriggerBonus
};
