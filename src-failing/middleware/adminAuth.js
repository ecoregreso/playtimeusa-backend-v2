// src/middleware/adminAuth.js
const jwt = require('jsonwebtoken');
const { AdminUser } = require('../models');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.warn('[ADMIN AUTH] JWT_SECRET is not set in environment.');
}

async function authAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const [, token] = authHeader.split(' ');

    if (!token) {
      return res.status(401).json({ error: 'missing_token' });
    }

    const payload = jwt.verify(token, JWT_SECRET);

    const admin = await AdminUser.findByPk(payload.sub);

    if (!admin || !admin.isActive) {
      return res.status(401).json({ error: 'invalid_admin' });
    }

    req.admin = {
      id: admin.id,
      email: admin.email,
      role: admin.role,
    };

    next();
  } catch (err) {
    console.error('[ADMIN AUTH] error:', err);
    return res.status(401).json({ error: 'invalid_token' });
  }
}

function requireRole(requiredRole) {
  return (req, res, next) => {
    if (!req.admin) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (req.admin.role !== requiredRole) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}

module.exports = {
  authAdmin,
  requireRole,
};

