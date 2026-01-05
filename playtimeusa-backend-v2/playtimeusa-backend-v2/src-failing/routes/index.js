// src/routes/index.js
const express = require('express');
const router = express.Router();

const voucherRoutes = require('./voucherRoutes');
const playerRoutes = require('./playerRoutes');
const betRoutes = require('./betRoutes');

router.get('/health', (req, res) => {
  res.json({ ok: true, status: 'playtime-backend-v2-up' });
});

router.use('/voucher', voucherRoutes);
router.use('/player', playerRoutes);
router.use('/bet', betRoutes);

module.exports = router;
