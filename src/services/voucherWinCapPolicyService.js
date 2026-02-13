function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function uniquePercents(input, fallback = []) {
  const source = Array.isArray(input) ? input : fallback;
  const values = [];
  for (const raw of source) {
    const n = toNumber(raw, null);
    if (n == null || n <= 0) continue;
    const rounded = Math.round(n * 100) / 100;
    if (!values.includes(rounded)) values.push(rounded);
  }
  if (!values.length) {
    return [...fallback];
  }
  return values.sort((a, b) => a - b);
}

const DEFAULT_PERCENT_OPTIONS = Object.freeze([120, 150, 175, 200, 250, 300]);
const DEFAULT_RANDOM_PERCENT_OPTIONS = Object.freeze([150, 175, 200, 225, 250, 300]);
const WIN_CAP_MODES = Object.freeze({
  FIXED: "fixed_percent",
  RANDOM: "random_percent",
});

const DEFAULT_VOUCHER_WIN_CAP_POLICY = Object.freeze({
  mode: WIN_CAP_MODES.FIXED,
  fixedPercent: 200,
  percentOptions: [...DEFAULT_PERCENT_OPTIONS],
  randomPercentOptions: [...DEFAULT_RANDOM_PERCENT_OPTIONS],
  decayRate: 0.08,
  minDecayAmount: 0.01,
  stakeDecayMultiplier: 0.35,
});

function normalizeVoucherWinCapPolicy(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const mode = raw.mode === WIN_CAP_MODES.RANDOM ? WIN_CAP_MODES.RANDOM : WIN_CAP_MODES.FIXED;
  const percentOptions = uniquePercents(raw.percentOptions, DEFAULT_PERCENT_OPTIONS);
  const randomPercentOptions = uniquePercents(raw.randomPercentOptions, DEFAULT_RANDOM_PERCENT_OPTIONS);

  let fixedPercent = toNumber(raw.fixedPercent, DEFAULT_VOUCHER_WIN_CAP_POLICY.fixedPercent);
  fixedPercent = clamp(Math.round(fixedPercent * 100) / 100, 1, 10000);

  if (!percentOptions.includes(fixedPercent)) {
    fixedPercent = percentOptions.includes(DEFAULT_VOUCHER_WIN_CAP_POLICY.fixedPercent)
      ? DEFAULT_VOUCHER_WIN_CAP_POLICY.fixedPercent
      : percentOptions[0];
  }

  return {
    mode,
    fixedPercent,
    percentOptions,
    randomPercentOptions: randomPercentOptions.length ? randomPercentOptions : [...percentOptions],
    decayRate: clamp(toNumber(raw.decayRate, DEFAULT_VOUCHER_WIN_CAP_POLICY.decayRate), 0.01, 0.5),
    minDecayAmount: Math.max(0, toNumber(raw.minDecayAmount, DEFAULT_VOUCHER_WIN_CAP_POLICY.minDecayAmount)),
    stakeDecayMultiplier: Math.max(
      0,
      toNumber(raw.stakeDecayMultiplier, DEFAULT_VOUCHER_WIN_CAP_POLICY.stakeDecayMultiplier)
    ),
  };
}

function pickRandomPercent(options, rng = Math.random) {
  if (!Array.isArray(options) || !options.length) {
    return DEFAULT_VOUCHER_WIN_CAP_POLICY.fixedPercent;
  }
  const idx = Math.floor(rng() * options.length);
  return options[Math.max(0, Math.min(idx, options.length - 1))];
}

function resolveVoucherWinCapSelection({ policyRaw, mode, percent, rng = Math.random }) {
  const policy = normalizeVoucherWinCapPolicy(policyRaw);

  const requestedMode = mode === WIN_CAP_MODES.RANDOM ? WIN_CAP_MODES.RANDOM : WIN_CAP_MODES.FIXED;
  const effectiveMode = mode ? requestedMode : policy.mode;

  if (effectiveMode === WIN_CAP_MODES.RANDOM) {
    const selectedPercent = pickRandomPercent(policy.randomPercentOptions, rng);
    return {
      policy,
      mode: WIN_CAP_MODES.RANDOM,
      selectedPercent,
      source: "policy_random",
    };
  }

  const requestedPercent = toNumber(percent, null);
  if (requestedPercent != null && requestedPercent > 0) {
    const rounded = Math.round(requestedPercent * 100) / 100;
    if (policy.percentOptions.includes(rounded)) {
      return {
        policy,
        mode: WIN_CAP_MODES.FIXED,
        selectedPercent: rounded,
        source: "request_fixed",
      };
    }
  }

  return {
    policy,
    mode: WIN_CAP_MODES.FIXED,
    selectedPercent: policy.fixedPercent,
    source: "policy_fixed",
  };
}

function computeMaxCashoutFromPercent({ amount, bonusAmount = 0, selectedPercent }) {
  const voucherAmount = Math.max(0, toNumber(amount, 0));
  const bonus = Math.max(0, toNumber(bonusAmount, 0));
  const totalCredit = voucherAmount + bonus;
  const pct = clamp(toNumber(selectedPercent, 0), 0, 10000);
  const computed = (voucherAmount * pct) / 100;
  const maxCashout = Math.max(totalCredit, computed);
  return Math.round(maxCashout * 10000) / 10000;
}

function buildVoucherWinCapOptions(policyRaw) {
  const policy = normalizeVoucherWinCapPolicy(policyRaw);
  return {
    modes: [
      { value: WIN_CAP_MODES.FIXED, label: "Fixed % of voucher" },
      { value: WIN_CAP_MODES.RANDOM, label: "Random from list" },
    ],
    percentOptions: policy.percentOptions.map((p) => ({ value: p, label: `${p}%` })),
    randomPercentOptions: policy.randomPercentOptions.map((p) => ({ value: p, label: `${p}%` })),
    defaults: policy,
  };
}

module.exports = {
  WIN_CAP_MODES,
  DEFAULT_VOUCHER_WIN_CAP_POLICY,
  normalizeVoucherWinCapPolicy,
  resolveVoucherWinCapSelection,
  computeMaxCashoutFromPercent,
  buildVoucherWinCapOptions,
};
