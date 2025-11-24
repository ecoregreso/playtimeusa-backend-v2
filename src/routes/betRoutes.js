// src/routes/betRoutes.js
const express = require('express');
const router = express.Router();

// If we want auth on bet routes later, we can plug it back in:
// const auth = require('../middleware/auth');

// Simple test endpoint for bets
router.post('/ping', (req, res) => {
  res.json({
    ok: true,
    scope: 'bet',
    time: new Date().toISOString(),
    body: req.body || null
  });
});

// Export the router
module.exports = router;
