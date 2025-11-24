// src/middleware/staffAuth.js

// TEMPORARY STAFF AUTH MIDDLEWARE
// For now this just lets every request pass through.
// We'll add real staff JWT / role checks once the server is fully running.

function staffAuth(req, res, next) {
  // console.log('Staff auth hit:', req.method, req.originalUrl);
  next();
}

// This matches routes that do: router.get('/me', requireStaffAuth(), ...)
function requireStaffAuth() {
  // In a real app you might accept options here.
  // For now, just return the staffAuth middleware.
  return staffAuth;
}

// Export in multiple ways so whatever staffRoutes expects is defined.
module.exports = requireStaffAuth;               // require('../middleware/staffAuth')
module.exports.requireStaffAuth = requireStaffAuth; // const { requireStaffAuth } = require('../middleware/staffAuth')
module.exports.staffAuth = staffAuth;
module.exports.authenticateStaff = staffAuth;
module.exports.protectStaff = staffAuth;
