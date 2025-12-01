// src/middleware/staffAuth.js
const jwt = require('jsonwebtoken');
const { StaffUser } = require('../models');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function getTokenFromHeader(req) {
  const auth = req.headers.authorization || req.headers.Authorization;
  if (!auth) return null;
  const parts = auth.split(' ');
  if (parts.length !== 2) return null;
  const [scheme, token] = parts;
  if (!/^Bearer$/i.test(scheme)) return null;
  return token;
}

function requireStaffAuth() {
  return async (req, res, next) => {
    try {
      const token = getTokenFromHeader(req);
      if (!token) {
        return res.status(401).json({ error: 'Staff auth required' });
      }

      let payload;
      try {
        payload = jwt.verify(token, JWT_SECRET);
      } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }

      const staff = await StaffUser.findByPk(payload.id);
      if (!staff || !staff.isActive) {
        return res.status(401).json({ error: 'Staff account inactive or missing' });
      }

      req.staff = {
        id: staff.id,
        username: staff.username,
        role: staff.role,
        agentCode: staff.agentCode,
        parentId: staff.parentId,
      };

      next();
    } catch (err) {
      console.error('[AUTH] requireStaffAuth error:', err);
      res.status(500).json({ error: 'Internal auth error' });
    }
  };
}

function requireStaffRole(roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];

  return [
    requireStaffAuth(),
    (req, res, next) => {
      if (!req.staff) {
        return res.status(401).json({ error: 'Staff auth required' });
      }

      if (!allowed.includes(req.staff.role)) {
        return res.status(403).json({ error: 'Insufficient role' });
      }

      next();
    },
  ];
}

module.exports = {
  requireStaffAuth,
  requireStaffRole,
};
