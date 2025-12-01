// src/middleware/staffAuth.js

const jwt = require('jsonwebtoken');
const { StaffUser } = require('../models');

const JWT_SECRET = process.env.JWT_SECRET || 'development-secret-change-me';

function requireStaffAuth(requiredPermissions = []) {
  return async function staffAuthMiddleware(req, res, next) {
    try {
      const header = req.headers['authorization'] || '';
      const parts = header.split(' ');
      if (parts.length !== 2 || parts[0] !== 'Bearer') {
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      }

      const token = parts[1].trim();
      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch (err) {
        return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
      }

      if (!decoded || decoded.type !== 'staff') {
        return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
      }

      const staff = await StaffUser.findByPk(decoded.sub);
      if (!staff || !staff.isActive) {
        return res.status(403).json({ ok: false, error: 'STAFF_INACTIVE' });
      }

      if (decoded.tenantId && staff.tenantId !== decoded.tenantId) {
        return res.status(403).json({ ok: false, error: 'TENANT_MISMATCH' });
      }

      const tokenPerms = Array.isArray(decoded.perms) ? decoded.perms : [];
      const dbPerms = Array.isArray(staff.permissions) ? staff.permissions : [];
      const effectivePerms = tokenPerms.length ? tokenPerms : dbPerms;

      if (
        Array.isArray(requiredPermissions) &&
        requiredPermissions.length > 0
      ) {
        const missing = requiredPermissions.filter(
          (p) => !effectivePerms.includes(p)
        );
        if (missing.length > 0) {
          return res.status(403).json({
            ok: false,
            error: 'INSUFFICIENT_PERMISSIONS',
            missing,
          });
        }
      }

      req.staff = {
        id: staff.id,
        tenantId: staff.tenantId,
        role: staff.role,
        permissions: effectivePerms,
      };

      return next();
    } catch (err) {
      console.error('staffAuth error', err);
      return res.status(500).json({ ok: false, error: 'AUTH_ERROR' });
    }
  };
}

module.exports = {
  requireStaffAuth,
};
