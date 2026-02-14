const OUTCOME_MODES = Object.freeze({
  VOUCHER_CONTROLLED: "voucher_controlled",
  PURE_RNG: "pure_rng",
});

const DEFAULT_OUTCOME_MODE = OUTCOME_MODES.VOUCHER_CONTROLLED;

function normalizeOutcomeMode(value, fallback = DEFAULT_OUTCOME_MODE) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();

  if (
    raw === OUTCOME_MODES.PURE_RNG ||
    raw === "rng" ||
    raw === "random" ||
    raw === "legacy_rng" ||
    raw === "original_rng"
  ) {
    return OUTCOME_MODES.PURE_RNG;
  }

  if (
    raw === OUTCOME_MODES.VOUCHER_CONTROLLED ||
    raw === "voucher" ||
    raw === "voucher_cap" ||
    raw === "voucher_wincap"
  ) {
    return OUTCOME_MODES.VOUCHER_CONTROLLED;
  }

  return fallback;
}

function isVoucherControlledOutcomeMode(mode) {
  return normalizeOutcomeMode(mode) === OUTCOME_MODES.VOUCHER_CONTROLLED;
}

function isPureRngOutcomeMode(mode) {
  return normalizeOutcomeMode(mode) === OUTCOME_MODES.PURE_RNG;
}

function buildOutcomeModeOptions(currentMode = DEFAULT_OUTCOME_MODE) {
  const normalizedCurrent = normalizeOutcomeMode(currentMode);
  return {
    currentMode: normalizedCurrent,
    options: [
      {
        value: OUTCOME_MODES.VOUCHER_CONTROLLED,
        label: "Voucher Controlled",
        description:
          "Game outcomes follow voucher win-cap and decay policy while jackpots remain separate.",
      },
      {
        value: OUTCOME_MODES.PURE_RNG,
        label: "Pure RNG",
        description:
          "Game outcomes are fully random; vouchers remain identity, wallet, and activity ledger only.",
      },
    ],
  };
}

module.exports = {
  OUTCOME_MODES,
  DEFAULT_OUTCOME_MODE,
  normalizeOutcomeMode,
  isVoucherControlledOutcomeMode,
  isPureRngOutcomeMode,
  buildOutcomeModeOptions,
};
