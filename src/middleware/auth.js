const { initTenantContext } = require("./tenantContext");
const { verifyAccessToken } = require("../utils/jwt");
const User = require("../models/User");

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    return header.slice(7);
  }
  return null;
}

async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    console.error("[AUTH] Access token error:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  req.user = {
    id: payload.sub,
    role: payload.role,
    tenantId: payload.tenantId || null,
    distributorId: payload.distributorId || null,
  };
  req.auth = {
    userId: payload.sub,
    role: payload.role,
    tenantId: payload.tenantId || null,
    distributorId: payload.distributorId || null,
  };

  try {
    const user = await User.findByPk(payload.sub, {
      attributes: ["id", "role", "isActive", "tenantId"],
    });
    if (!user) {
      return res.status(401).json({ error: "Invalid user" });
    }
    if (!user.isActive) {
      return res.status(403).json({ error: "Account disabled" });
    }
    if (String(user.role || "") !== String(payload.role || "")) {
      return res.status(403).json({ error: "Role mismatch" });
    }
    req.user.tenantId = user.tenantId || req.user.tenantId || null;
    req.auth.tenantId = req.user.tenantId;
  } catch (err) {
    return res.status(500).json({ error: "Failed to validate user account" });
  }

  try {
    return await initTenantContext(
      req,
      res,
      {
        tenantId: payload.tenantId || null,
        role: payload.role,
        userId: payload.sub,
        distributorId: payload.distributorId || null,
      },
      () => next()
    );
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || "Tenant context error" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role' });
    }
    next();
  };
}

function requireAdminToken(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  try {
    const payload = verifyAccessToken(token);
    if (!payload || payload.role !== 'admin') {
      return res.status(403).json({ error: 'Invalid admin token' });
    }
    req.admin = {
      id: payload.sub,
      role: payload.role,
    };
    next();
  } catch (err) {
    console.error('[AUTH] Admin token error:', err.message);
    return res.status(401).json({ error: 'Invalid or expired admin token' });
  }
}

module.exports = {
  requireAuth,
  requireRole,
  requireAdminToken,
};
