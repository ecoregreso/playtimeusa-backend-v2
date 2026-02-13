const { Transaction } = require("../models");

const BONUS_TRIGGER_BALANCE = 0.5;

function toNumber(value) {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toMinor(value) {
  return Math.round(toNumber(value) * 100);
}

function buildBonusState(wallet) {
  const pending = toNumber(wallet?.bonusPending);
  const unacked = toNumber(wallet?.bonusUnacked);
  return {
    pending,
    unacked,
    ackRequired: unacked > 0,
    pendingMinor: toMinor(pending),
    appliedMinor: toMinor(unacked),
  };
}

async function applyPendingBonusIfEligible({ wallet, transaction, reference, metadata }) {
  if (!wallet) return null;
  const pending = toNumber(wallet.bonusPending);
  if (pending <= 0) return null;

  const balanceMinor = toMinor(wallet.balance);
  if (balanceMinor > BONUS_TRIGGER_BALANCE * 100) return null;

  const balanceBefore = toNumber(wallet.balance);
  const applied = pending;

  const saveOptions = transaction ? { transaction } : undefined;

  wallet.balance = balanceBefore + applied;
  wallet.bonusPending = 0;
  wallet.bonusUnacked = toNumber(wallet.bonusUnacked) + applied;
  await wallet.save(saveOptions);

  await Transaction.create(
    {
      tenantId: wallet.tenantId || null,
      walletId: wallet.id,
      type: "voucher_credit",
      amount: applied,
      balanceBefore,
      balanceAfter: wallet.balance,
      reference: reference || "bonus:pending",
      metadata: {
        ...(metadata || {}),
        bonusApplied: true,
        bonusAmount: applied,
      },
    },
    saveOptions
  );

  return {
    applied,
    unacked: wallet.bonusUnacked,
    balance: wallet.balance,
  };
}

module.exports = {
  BONUS_TRIGGER_BALANCE,
  applyPendingBonusIfEligible,
  buildBonusState,
};
