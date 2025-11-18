const express = require('express');
const router = express.Router();

const voucherRoutes = require('./voucherRoutes');
const playerRoutes = require('./playerRoutes');
const betRoutes = require('./betRoutes');
const adminRoutes = require('./adminRoutes'); // <- add this

// Healthcheck
router.get('/health', (req, res) => {
  res.json({ ok: true, status: 'playtime-backend-v2-up' });
});

router.use('/voucher', voucherRoutes);
router.use('/player', playerRoutes);
router.use('/bet', betRoutes);
router.use('/admin', adminRoutes); // <- and this

module.exports = router;

