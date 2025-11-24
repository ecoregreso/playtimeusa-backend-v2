// src/routes/betRoutes.js
const express = require('express');
const router = express.Router();
const { spinHandler } = require('../controllers/betController');
const { requirePlayerAuth } = require('../middleware/auth');

router.post('/spin', requirePlayerAuth, spinHandler);

module.exports = router;
