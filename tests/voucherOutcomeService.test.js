const {
  resolveVoucherMaxCashout,
  computeVoucherDrivenPayout,
  buildVoucherPolicyMetadata,
} = require("../src/services/voucherOutcomeService");

function rngFrom(values) {
  let i = 0;
  return () => {
    if (i >= values.length) return values[values.length - 1] ?? 0.5;
    const v = values[i];
    i += 1;
    return v;
  };
}

describe("voucherOutcomeService", () => {
  test("resolveVoucherMaxCashout honors explicit voucher max", () => {
    const value = resolveVoucherMaxCashout({
      amount: 20,
      bonusAmount: 5,
      maxCashout: 140,
    });

    expect(value).toBe(140);
  });

  test("pre-cap payout never exceeds max cashout", () => {
    const outcome = computeVoucherDrivenPayout({
      stakeAmount: 20,
      balanceBeforeBet: 95,
      balanceAfterBet: 75,
      requestedWinAmount: 999,
      maxCashout: 100,
      policy: { decayMode: false },
      rng: rngFrom([0.1, 0.99, 0.99]),
    });

    expect(outcome.mode).toBe("normal");
    expect(outcome.payoutAmount).toBe(25);
    expect(outcome.balanceAfterSettle).toBe(100);
    expect(outcome.reachedOrExceededCap).toBe(true);
  });

  test("decay mode enforces downward trajectory after cap", () => {
    const outcome = computeVoucherDrivenPayout({
      stakeAmount: 10,
      balanceBeforeBet: 100,
      balanceAfterBet: 90,
      requestedWinAmount: 999,
      maxCashout: 100,
      policy: {
        decayMode: true,
        decayRate: 0.1,
        minDecayAmount: 1,
        stakeDecayMultiplier: 0.2,
      },
      rng: rngFrom([0.1, 0.9, 0.9]),
    });

    expect(outcome.mode).toBe("decay");
    expect(outcome.payoutAmount).toBe(0);
    expect(outcome.balanceAfterSettle).toBeLessThanOrEqual(90);
    expect(outcome.reachedOrExceededCap).toBe(true);
  });

  test("buildVoucherPolicyMetadata marks cap reached and decay mode", () => {
    const voucher = {
      metadata: {},
    };

    const next = buildVoucherPolicyMetadata(voucher, {
      maxCashout: 200,
      payoutOutcome: {
        mode: "normal",
        reachedOrExceededCap: true,
      },
      balanceAfterSettle: 200,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(next.voucherPolicy.maxCashout).toBe(200);
    expect(next.voucherPolicy.capReachedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(next.voucherPolicy.decayMode).toBe(true);
  });
});
