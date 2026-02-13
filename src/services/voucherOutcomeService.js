function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toMoney(value) {
  const n = toNumber(value, 0);
  return Math.round(n * 10000) / 10000;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomBetween(min, max, rng) {
  return min + (max - min) * rng();
}

const EPSILON = 0.0001;
const DEFAULT_CASHOUT_MULTIPLIER = clamp(
  toNumber(process.env.VOUCHER_DEFAULT_MAX_CASHOUT_MULTIPLIER, 2.5),
  1,
  100
);
const DEFAULT_DECAY_RATE = clamp(
  toNumber(process.env.VOUCHER_DECAY_RATE, 0.08),
  0.01,
  0.5
);
const DEFAULT_MIN_DECAY_AMOUNT = Math.max(
  0,
  toNumber(process.env.VOUCHER_DECAY_MIN_AMOUNT, 0.01)
);
const DEFAULT_STAKE_DECAY_MULTIPLIER = Math.max(
  0,
  toNumber(process.env.VOUCHER_DECAY_STAKE_MULTIPLIER, 0.35)
);

function resolveVoucherMaxCashout(voucher, fallbackAmount = 0) {
  const metadata = voucher?.metadata && typeof voucher.metadata === "object" ? voucher.metadata : {};
  const policy = metadata.voucherPolicy && typeof metadata.voucherPolicy === "object"
    ? metadata.voucherPolicy
    : {};

  const amount = toNumber(voucher?.amount, 0) || 0;
  const bonusAmount = toNumber(voucher?.bonusAmount, 0) || 0;
  const totalCredit =
    toNumber(voucher?.totalCredit, null) ??
    toNumber(voucher?.total_credit, null) ??
    amount + bonusAmount;

  const candidates = [
    toNumber(voucher?.maxCashout, null),
    toNumber(policy.maxCashout, null),
    toNumber(metadata.maxCashout, null),
    toNumber(fallbackAmount, null) ? toNumber(fallbackAmount, 0) * DEFAULT_CASHOUT_MULTIPLIER : null,
    toNumber(totalCredit, null),
  ];

  for (const value of candidates) {
    if (value != null && value > 0) {
      return toMoney(value);
    }
  }

  return 0;
}

function readVoucherPolicy(voucher) {
  const metadata = voucher?.metadata && typeof voucher.metadata === "object" ? voucher.metadata : {};
  const policy = metadata.voucherPolicy && typeof metadata.voucherPolicy === "object"
    ? metadata.voucherPolicy
    : {};

  const maxCashout = resolveVoucherMaxCashout(voucher);
  const capReachedAt = policy.capReachedAt || metadata.capReachedAt || null;
  const decayMode = Boolean(policy.decayMode || capReachedAt);
  const trackedRaw = toNumber(policy.trackedBalance, null);
  const trackedFromLast = toNumber(policy.lastBalance, 0);
  const trackedBalance = Math.max(0, trackedRaw != null ? trackedRaw : trackedFromLast);

  return {
    maxCashout,
    capReachedAt,
    decayMode,
    hasTrackedBalance: trackedRaw != null,
    trackedBalance,
    decayRounds: Math.max(0, parseInt(policy.decayRounds || 0, 10) || 0),
    decayRate: clamp(toNumber(policy.decayRate, DEFAULT_DECAY_RATE), 0.01, 0.5),
    minDecayAmount: Math.max(0, toNumber(policy.minDecayAmount, DEFAULT_MIN_DECAY_AMOUNT)),
    stakeDecayMultiplier: Math.max(
      0,
      toNumber(policy.stakeDecayMultiplier, DEFAULT_STAKE_DECAY_MULTIPLIER)
    ),
  };
}

function samplePreCapPayout({ stakeAmount, progress, rng }) {
  const hitChance = clamp(0.72 - progress * 0.35, 0.32, 0.78);
  if (rng() > hitChance) {
    return 0;
  }

  const bucket = rng();
  let minMult = 0.35;
  let maxMult = 1.35;

  if (bucket > 0.78 && bucket <= 0.96) {
    minMult = 1.35;
    maxMult = 2.75;
  } else if (bucket > 0.96) {
    minMult = 2.75;
    maxMult = 5.5;
  }

  return stakeAmount * randomBetween(minMult, maxMult, rng);
}

function sampleDecayPayout({ stakeAmount, rng }) {
  const hitChance = 0.28;
  if (rng() > hitChance) {
    return 0;
  }

  const bucket = rng();
  let minMult = 0.08;
  let maxMult = 0.6;

  if (bucket > 0.85) {
    minMult = 0.6;
    maxMult = 1.05;
  }

  return stakeAmount * randomBetween(minMult, maxMult, rng);
}

function computeVoucherDrivenPayout({
  stakeAmount,
  balanceBeforeBet,
  balanceAfterBet,
  requestedWinAmount,
  maxCashout,
  policy = {},
  rng = Math.random,
}) {
  const stake = Math.max(0, toNumber(stakeAmount, 0));
  const before = Math.max(0, toNumber(balanceBeforeBet, 0));
  const afterBet = Math.max(0, toNumber(balanceAfterBet, 0));
  const cap = Math.max(0, toNumber(maxCashout, 0));
  const progress = cap > 0 ? clamp(before / cap, 0, 1) : 0;

  const atOrOverCap =
    Boolean(policy.decayMode) ||
    (cap > 0 && (before >= cap - EPSILON || afterBet >= cap - EPSILON));

  if (atOrOverCap) {
    const decayRate = clamp(
      toNumber(policy.decayRate, DEFAULT_DECAY_RATE),
      0.01,
      0.5
    );
    const minDecay = Math.max(
      0,
      toNumber(policy.minDecayAmount, DEFAULT_MIN_DECAY_AMOUNT)
    );
    const stakeDecay =
      stake *
      Math.max(
        0,
        toNumber(policy.stakeDecayMultiplier, DEFAULT_STAKE_DECAY_MULTIPLIER)
      );

    const decayStep = Math.max(minDecay, before * decayRate, stakeDecay);
    const targetBalanceAfterSettle = Math.max(0, before - decayStep);
    const maxWinAllowed = Math.max(0, targetBalanceAfterSettle - afterBet);

    const sampled = sampleDecayPayout({ stakeAmount: stake, rng });
    const payout = clamp(sampled, 0, maxWinAllowed);
    const balanceAfterSettle = afterBet + payout;

    return {
      payoutAmount: toMoney(payout),
      balanceAfterSettle: toMoney(balanceAfterSettle),
      mode: "decay",
      progress,
      reachedOrExceededCap: true,
      decayStep: toMoney(decayStep),
      targetBalanceAfterSettle: toMoney(targetBalanceAfterSettle),
      capApplied: cap > 0,
    };
  }

  const sampled = samplePreCapPayout({ stakeAmount: stake, progress, rng });
  const maxWinByCap = cap > 0 ? Math.max(0, cap - afterBet) : Number.POSITIVE_INFINITY;
  const payout = clamp(sampled, 0, maxWinByCap);
  const balanceAfterSettle = afterBet + payout;
  const reachedOrExceededCap = cap > 0 && balanceAfterSettle >= cap - EPSILON;

  return {
    payoutAmount: toMoney(payout),
    balanceAfterSettle: toMoney(balanceAfterSettle),
    mode: "normal",
    progress,
    reachedOrExceededCap,
    decayStep: 0,
    targetBalanceAfterSettle: toMoney(balanceAfterSettle),
    capApplied: cap > 0,
  };
}

function buildVoucherPolicyMetadata(voucher, { maxCashout, payoutOutcome, balanceAfterSettle, now = new Date() }) {
  const metadata = voucher?.metadata && typeof voucher.metadata === "object" ? { ...voucher.metadata } : {};
  const current = metadata.voucherPolicy && typeof metadata.voucherPolicy === "object"
    ? { ...metadata.voucherPolicy }
    : {};

  const next = {
    ...current,
    maxCashout: toMoney(maxCashout),
    lastBalance: toMoney(balanceAfterSettle),
    trackedBalance: toMoney(balanceAfterSettle),
    lastMode: payoutOutcome.mode,
    decayRate: toNumber(current.decayRate, DEFAULT_DECAY_RATE),
    minDecayAmount: toNumber(current.minDecayAmount, DEFAULT_MIN_DECAY_AMOUNT),
    stakeDecayMultiplier: toNumber(
      current.stakeDecayMultiplier,
      DEFAULT_STAKE_DECAY_MULTIPLIER
    ),
  };

  if (payoutOutcome.reachedOrExceededCap && !next.capReachedAt) {
    next.capReachedAt = now.toISOString();
  }

  if (next.capReachedAt) {
    next.decayMode = true;
  }

  if (payoutOutcome.mode === "decay") {
    next.decayRounds = Math.max(0, parseInt(current.decayRounds || 0, 10) || 0) + 1;
  } else {
    next.decayRounds = Math.max(0, parseInt(current.decayRounds || 0, 10) || 0);
  }

  metadata.voucherPolicy = next;
  metadata.maxCashout = next.maxCashout;
  return metadata;
}

module.exports = {
  resolveVoucherMaxCashout,
  readVoucherPolicy,
  computeVoucherDrivenPayout,
  buildVoucherPolicyMetadata,
};
