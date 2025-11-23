const express = require('express');
const router = express.Router();

const voucherRoutes = require('./voucherRoutes');
const playerRoutes = require('./playerRoutes');
const betRoutes = require('./betRoutes');
const adminRoutes = require('./adminRoutes'); const staffRoutes = require('./staffRoutes');
// <- add this

// Healthcheck
router.get('/health', (req, res) => {
  res.json({ ok: true, status: 'playtime-backend-v2-up' });
});

router.use('/voucher', voucherRoutes);
router.use('/player', playerRoutes);
router.use('/bet', betRoutes);
router.use('/admin', adminRoutes); router.use('/staff', staffRoutes);
// <- and this

module.exports = router;

