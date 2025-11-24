// src/middleware/auth.js

// TEMPORARY SIMPLE AUTH MIDDLEWARE
// Right now this just lets every request through.
// We'll upgrade this later to verify JWTs and roles.

function auth(req, res, next) {
  // console.log('Auth middleware hit:', req.method, req.originalUrl);
  next();
}

// Export in MANY ways so whatever the routes expect is defined.
module.exports = auth;                 // require('../middleware/auth')
module.exports.auth = auth;            // const { auth } = require('../middleware/auth')
module.exports.authMiddleware = auth;  // const { authMiddleware } = require('../middleware/auth')
module.exports.authenticate = auth;    // const { authenticate } = require('../middleware/auth')
module.exports.authenticatePlayer = auth; // const { authenticatePlayer } = require('../middleware/auth')
module.exports.protect = auth;         // const { protect } = require('../middleware/auth')
// src/middleware/auth.js

// TEMPORARY SIMPLE AUTH MIDDLEWARE
// Right now this just lets every request through.
// We'll upgrade this later to verify JWTs and roles.

function auth(req, res, next) {
  // You can log something for debugging if you want:
  // console.log('Auth middleware hit:', req.method, req.originalUrl);
  next();
}

// Export in multiple ways so routes can use it however they were written
module.exports = auth;      // if they do: const auth = require('../middleware/auth')
module.exports.auth = auth; // if they do: const { auth } = require('../middleware/auth');

