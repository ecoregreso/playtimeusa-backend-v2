const { buildVoucherPolicyState } = require("../src/services/voucherWalletStateService");

describe("voucherWalletStateService", () => {
  test("builds policy state from tracked voucher metadata", () => {
    const voucher = {
      id: "voucher-1",
      status: "redeemed",
      redeemedAt: "2026-02-13T00:00:00.000Z",
      expiresAt: null,
      amount: 100,
      bonusAmount: 50,
      maxCashout: 300,
      metadata: {
        voucherPolicy: {
          maxCashout: 300,
          trackedBalance: 120,
          decayMode: false,
          decayRounds: 0,
          lastMode: "normal",
        },
      },
    };

    const state = buildVoucherPolicyState({ voucher, walletBalance: 120 });

    expect(state.voucherId).toBe("voucher-1");
    expect(state.maxCashout).toBe(300);
    expect(state.trackedBalance).toBe(120);
    expect(state.remainingBeforeCap).toBe(180);
    expect(state.capProgress).toBe(0.4);
    expect(state.decayMode).toBe(false);
    expect(state.lastMode).toBe("normal");
    expect(state.jackpotExcludedFromCap).toBe(true);
  });

  test("falls back to wallet balance when tracked balance is missing", () => {
    const voucher = {
      id: "voucher-2",
      status: "redeemed",
      amount: 100,
      bonusAmount: 0,
      maxCashout: 200,
      metadata: {},
    };

    const state = buildVoucherPolicyState({ voucher, walletBalance: 150 });

    expect(state.maxCashout).toBe(200);
    expect(state.trackedBalance).toBe(150);
    expect(state.remainingBeforeCap).toBe(50);
    expect(state.capProgress).toBe(0.75);
  });

  test("reports decay mode when cap has been reached", () => {
    const voucher = {
      id: "voucher-3",
      status: "redeemed",
      amount: 50,
      bonusAmount: 0,
      maxCashout: 100,
      metadata: {
        voucherPolicy: {
          maxCashout: 100,
          trackedBalance: 90,
          capReachedAt: "2026-02-13T01:00:00.000Z",
          decayMode: true,
          decayRounds: 7,
          lastMode: "decay",
        },
      },
    };

    const state = buildVoucherPolicyState({ voucher, walletBalance: 90 });

    expect(state.decayMode).toBe(true);
    expect(state.capReachedAt).toBe("2026-02-13T01:00:00.000Z");
    expect(state.decayRounds).toBe(7);
    expect(state.lastMode).toBe("decay");
  });
});
