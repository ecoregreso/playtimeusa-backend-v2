// src/routes/voucherRoutes.js
const express = require('express');
const router = express.Router();
const {
  issueVoucherHandler,
  redeemVoucherHandler
} = require('../controllers/voucherController');

// Agent issues voucher
router.post('/agents/:tenantId/vouchers', issueVoucherHandler);

// Player redeems voucher
router.post('/redeem', redeemVoucherHandler);

module.exports = router;
