const { Op } = require("sequelize");
const { getJson } = require("../utils/ownerSettings");
const {
  resolveVoucherMaxCashout,
  readVoucherPolicy,
} = require("./voucherOutcomeService");
const {
  DEFAULT_OUTCOME_MODE,
  normalizeOutcomeMode,
  isVoucherControlledOutcomeMode,
} = require("./outcomeModeService");

const SYSTEM_CONFIG_KEY = "system_config";

function tenantConfigKey(tenantId) {
  return `tenant:${tenantId}:config`;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toMoney(value) {
  return Math.round(toNumber(value, 0) * 10000) / 10000;
}

function buildVoucherPolicyState({
  voucher,
  walletBalance = 0,
  outcomeMode = DEFAULT_OUTCOME_MODE,
}) {
  if (!voucher) return null;

  const normalizedOutcomeMode = normalizeOutcomeMode(outcomeMode, DEFAULT_OUTCOME_MODE);
  const outcomesControlledByVoucher = isVoucherControlledOutcomeMode(normalizedOutcomeMode);
  const maxCashout = resolveVoucherMaxCashout(
    voucher,
    toNumber(voucher?.amount, 0) + toNumber(voucher?.bonusAmount, 0)
  );
  const policySnapshot = readVoucherPolicy(voucher);
  const trackedBalance = toMoney(
    Math.max(
      0,
      policySnapshot.hasTrackedBalance
        ? toNumber(policySnapshot.trackedBalance, 0)
        : Math.min(maxCashout, toNumber(walletBalance, 0))
    )
  );
  const remainingBeforeCap = toMoney(
    maxCashout > 0 ? Math.max(0, maxCashout - trackedBalance) : 0
  );
  const capProgress = maxCashout > 0 ? Math.min(1, trackedBalance / maxCashout) : 0;

  return {
    voucherId: voucher.id,
    status: voucher.status,
    redeemedAt: voucher.redeemedAt || null,
    expiresAt: voucher.expiresAt || null,
    outcomeMode: normalizedOutcomeMode,
    outcomesControlledByVoucher,
    maxCashout: outcomesControlledByVoucher ? toMoney(maxCashout) : null,
    trackedBalance: outcomesControlledByVoucher ? trackedBalance : null,
    remainingBeforeCap: outcomesControlledByVoucher ? remainingBeforeCap : null,
    capProgress: outcomesControlledByVoucher ? toMoney(capProgress) : null,
    decayMode: outcomesControlledByVoucher ? Boolean(policySnapshot.decayMode) : false,
    capReachedAt: outcomesControlledByVoucher ? policySnapshot.capReachedAt || null : null,
    decayRounds: outcomesControlledByVoucher ? Number(policySnapshot.decayRounds || 0) : 0,
    lastMode:
      (outcomesControlledByVoucher
        ? (voucher?.metadata &&
          typeof voucher.metadata === "object" &&
          voucher.metadata.voucherPolicy &&
          typeof voucher.metadata.voucherPolicy === "object"
            ? voucher.metadata.voucherPolicy.lastMode
            : null) || null
        : "pure_rng"),
    jackpotExcludedFromCap: true,
  };
}

async function resolveOutcomeModeForTenant(tenantId) {
  const normalizedTenantId = tenantId || null;
  const system = await getJson(SYSTEM_CONFIG_KEY, {});
  const tenant = normalizedTenantId ? await getJson(tenantConfigKey(normalizedTenantId), {}) : {};
  const merged = { ...(system || {}), ...(tenant || {}) };
  return normalizeOutcomeMode(merged?.outcomeMode, DEFAULT_OUTCOME_MODE);
}

async function resolveActiveVoucherForWallet({
  wallet,
  userId,
  tenantId,
  transaction = undefined,
  persistWalletLink = false,
}) {
  const { Voucher } = require("../models");
  if (!wallet || !userId) return null;

  const normalizedTenantId = tenantId || wallet.tenantId || null;

  let voucher = null;
  if (wallet.activeVoucherId) {
    voucher = await Voucher.findOne({
      where: {
        id: wallet.activeVoucherId,
        tenantId: normalizedTenantId,
      },
      transaction,
    });
  }

  if (!voucher) {
    voucher = await Voucher.findOne({
      where: {
        tenantId: normalizedTenantId,
        redeemedByUserId: userId,
        status: { [Op.in]: ["redeemed", "REDEEMED"] },
      },
      order: [
        ["redeemedAt", "DESC"],
        ["createdAt", "DESC"],
      ],
      transaction,
    });
  }

  if (
    persistWalletLink &&
    voucher &&
    wallet.activeVoucherId !== voucher.id &&
    typeof wallet.save === "function"
  ) {
    wallet.activeVoucherId = voucher.id;
    await wallet.save({ transaction });
  }

  return voucher;
}

async function resolveWalletVoucherPolicyState({
  wallet,
  userId,
  tenantId,
  transaction = undefined,
  persistWalletLink = false,
}) {
  if (!wallet || !userId) return null;

  const voucher = await resolveActiveVoucherForWallet({
    wallet,
    userId,
    tenantId,
    transaction,
    persistWalletLink,
  });
  const outcomeMode = await resolveOutcomeModeForTenant(tenantId || wallet.tenantId || null);

  return buildVoucherPolicyState({
    voucher,
    walletBalance: toNumber(wallet.balance, 0),
    outcomeMode,
  });
}

module.exports = {
  buildVoucherPolicyState,
  resolveActiveVoucherForWallet,
  resolveWalletVoucherPolicyState,
};
