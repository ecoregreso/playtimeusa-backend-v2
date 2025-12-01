const express = require('express');
const router = express.Router();
const config = require('../config/env');

router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    env: config.env,
  });
});

module.exports = router;
