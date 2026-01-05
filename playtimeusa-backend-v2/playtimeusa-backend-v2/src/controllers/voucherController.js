// src/controllers/voucherController.js
const { issueVoucher, redeemVoucher } = require('../services/voucherService');

async function issueVoucherHandler(req, res) {
  try {
    const agentTenantId = req.params.tenantId;
    const { amountMinor, prizeWheelEnabled } = req.body;

    const result = await issueVoucher({
      agentTenantId,
      amountMinor,
      prizeWheelEnabled: !!prizeWheelEnabled
    });

    res.json({ ok: true, voucher: result });
  } catch (err) {
    console.error('[issueVoucherHandler] error:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
}

async function redeemVoucherHandler(req, res) {
  try {
    const { code, pin } = req.body;

    const result = await redeemVoucher({
      code,
      pinPlain: pin
    });

    res.json({
      ok: true,
      player: {
        playerId: result.playerId,
        loginCode: result.loginCode,
        pin: result.pin,
        balanceMinor: result.balanceMinor,
        bonusAmountMinor: result.bonusAmountMinor,
        prizeWheelEnabled: result.prizeWheelEnabled
      }
    });
  } catch (err) {
    console.error('[redeemVoucherHandler] error:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
}

module.exports = {
  issueVoucherHandler,
  redeemVoucherHandler
};
