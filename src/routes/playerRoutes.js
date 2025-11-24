// src/routes/playerRoutes.js
const express = require('express');
const router = express.Router();

// Auth middleware (currently a no-op, but wired correctly)
const auth = require('../middleware/auth');

// Simple test route to prove player routes are working
router.get('/ping', (req, res) => {
  res.json({
    ok: true,
    scope: 'player',
    time: new Date().toISOString()
  });
});

// Export the router
module.exports = router;
