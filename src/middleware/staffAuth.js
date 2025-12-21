// src/middleware/staffAuth.js
const jwt = require("jsonwebtoken");
const { StaffUser } = require("../models");
const {
  PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS,
} = require("../constants/permissions");

const STAFF_JWT_SECRET =
  process.env.STAFF_JWT_SECRET || process.env.JWT_SECRET || "dev-staff-secret";
const STAFF_JWT_EXPIRES_IN = process.env.STAFF_JWT_EXPIRES_IN || "12h";

function normalizePermissions(staff) {
  const fromDb = Array.isArray(staff.permissions) ? staff.permissions : [];
  if (fromDb.length) return Array.from(new Set(fromDb));
  const defaults = ROLE_DEFAULT_PERMISSIONS[staff.role] || [];
  return Array.from(new Set(defaults));
}

function signStaffToken(staff) {
  const permissions = normalizePermissions(staff);
  const payload = {
    sub: staff.id,
    type: "staff",
    role: staff.role,
    permissions,
  };
  return jwt.sign(payload, STAFF_JWT_SECRET, {
    expiresIn: STAFF_JWT_EXPIRES_IN,
  });
}

function getToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) {
    return header.slice(7);
  }
  return null;
}

function hasPermissions(current, required = []) {
  if (!required || required.length === 0) return true;
  const set = new Set(current || []);
  return required.every((p) => set.has(p));
}

function requireStaffAuth(requiredPermissions = []) {
  return async (req, res, next) => {
    const token = getToken(req);
    if (!token) {
      return res
        .status(401)
        .json({ ok: false, error: "Missing Authorization header" });
    }

    let payload;
    try {
      payload = jwt.verify(token, STAFF_JWT_SECRET);
    } catch (err) {
      return res
        .status(401)
        .json({ ok: false, error: "Invalid or expired staff token" });
    }

    if (!payload || payload.type !== "staff") {
      return res.status(403).json({ ok: false, error: "Not a staff token" });
    }

    try {
      const staff = await StaffUser.findByPk(payload.sub);
      if (!staff || !staff.isActive) {
        return res.status(403).json({ ok: false, error: "Staff inactive" });
      }

      const permissions = normalizePermissions({
        ...staff.toJSON(),
        permissions: payload.permissions || staff.permissions,
      });

      if (!hasPermissions(permissions, requiredPermissions)) {
        return res
          .status(403)
          .json({ ok: false, error: "Forbidden: insufficient permissions" });
      }

      req.staff = {
        id: staff.id,
        username: staff.username,
        role: staff.role,
        permissions,
        agentCode: staff.agentCode,
        parentId: staff.parentId,
        isActive: staff.isActive,
      };

      return next();
    } catch (err) {
      console.error("[STAFF_AUTH] error:", err);
      return res.status(500).json({ ok: false, error: "Auth error" });
    }
  };
}

function requirePermission(permission) {
  const required = Array.isArray(permission) ? permission : [permission];
  return requireStaffAuth(required);
}

function requireStaffRole(roles = []) {
  const requiredRoles = Array.isArray(roles) ? roles : [roles];
  return (req, res, next) => {
    if (!req.staff) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    if (requiredRoles.length && !requiredRoles.includes(req.staff.role)) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }
    return next();
  };
}

const staffAuth = requireStaffAuth();

module.exports = {
  staffAuth,
  requireStaffAuth,
  requirePermission,
  requireStaffRole,
  PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS,
  signStaffToken,
};
