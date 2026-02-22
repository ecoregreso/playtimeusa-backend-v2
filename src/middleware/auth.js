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

  try {
    return await initTenantContext(
      req,
      res,
      {
        tenantId: payload.tenantId || null,
        role: payload.role,
        userId: payload.sub,
        distributorId: payload.distributorId || null,
        allowMissingTenant: payload.role === "owner",
      },
      async () => {
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
        if (
          payload.tenantId &&
          user.tenantId &&
          String(payload.tenantId) !== String(user.tenantId)
        ) {
          return res.status(403).json({ error: "Tenant mismatch" });
        }

        req.user = {
          id: user.id,
          role: user.role,
          tenantId: user.tenantId || payload.tenantId || null,
          distributorId: payload.distributorId || null,
        };
        req.auth = {
          userId: user.id,
          role: user.role,
          tenantId: req.user.tenantId,
          distributorId: payload.distributorId || null,
        };

        return next();
      }
    );
  } catch (err) {
    console.error("[AUTH] requireAuth error:", err.message || err);
    const status = err.status || 500;
    return res.status(status).json({ error: err.message || "Failed to validate user account" });
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
