// src/routes/playerRoutes.js
const express = require('express');
const router = express.Router();
const {
  loginHandler,
  getMeHandler,
  acknowledgeBonusHandler
} = require('../controllers/playerController');
const { requirePlayerAuth } = require('../middleware/auth');

router.post('/login', loginHandler);
router.get('/me', requirePlayerAuth, getMeHandler);
router.post('/bonus/ack', requirePlayerAuth, acknowledgeBonusHandler);

module.exports = router;
