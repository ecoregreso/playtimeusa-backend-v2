// src/middleware/auth.js
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

function requirePlayerAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (!token || scheme.toLowerCase() !== 'bearer') {
    return res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded || decoded.role !== 'player') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }

    req.user = {
      playerId: decoded.sub,
      role: decoded.role
    };

    next();
  } catch (err) {
    console.error('[auth] jwt error:', err.message);
    return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
  }
}

module.exports = {
  requirePlayerAuth
};
