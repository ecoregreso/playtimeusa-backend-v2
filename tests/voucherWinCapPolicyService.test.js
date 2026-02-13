const {
  WIN_CAP_MODES,
  normalizeVoucherWinCapPolicy,
  resolveVoucherWinCapSelection,
  computeMaxCashoutFromPercent,
} = require("../src/services/voucherWinCapPolicyService");

describe("voucherWinCapPolicyService", () => {
  test("normalizes policy arrays and defaults", () => {
    const policy = normalizeVoucherWinCapPolicy({
      mode: "fixed_percent",
      fixedPercent: 250,
      percentOptions: [300, 250, 250, 150],
      randomPercentOptions: [200, 220],
      decayRate: 0.12,
    });

    expect(policy.mode).toBe("fixed_percent");
    expect(policy.percentOptions).toEqual([150, 250, 300]);
    expect(policy.fixedPercent).toBe(250);
    expect(policy.randomPercentOptions).toEqual([200, 220]);
    expect(policy.decayRate).toBe(0.12);
  });

  test("fixed selection honors requested dropdown percent", () => {
    const selection = resolveVoucherWinCapSelection({
      policyRaw: {
        mode: WIN_CAP_MODES.FIXED,
        fixedPercent: 200,
        percentOptions: [150, 200, 250],
      },
      mode: WIN_CAP_MODES.FIXED,
      percent: 250,
    });

    expect(selection.mode).toBe("fixed_percent");
    expect(selection.selectedPercent).toBe(250);
    expect(selection.source).toBe("request_fixed");
  });

  test("random selection chooses from configured random list", () => {
    const selection = resolveVoucherWinCapSelection({
      policyRaw: {
        mode: WIN_CAP_MODES.RANDOM,
        randomPercentOptions: [160, 180],
      },
      mode: WIN_CAP_MODES.RANDOM,
      rng: () => 0.99,
    });

    expect(selection.mode).toBe("random_percent");
    expect(selection.selectedPercent).toBe(180);
  });

  test("max cashout percent uses voucher amount and never below total credit", () => {
    const cap = computeMaxCashoutFromPercent({
      amount: 100,
      bonusAmount: 50,
      selectedPercent: 120,
    });
    // 120% of amount = 120, but total credit is 150 so cap floors at 150.
    expect(cap).toBe(150);
  });
});
