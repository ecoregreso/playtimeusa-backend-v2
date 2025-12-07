// src/middleware/staffAuth.js
const jwt = require("jsonwebtoken");

const STAFF_JWT_SECRET = process.env.STAFF_JWT_SECRET || "dev-staff-secret";

function staffAuth(req, res, next) {
  const auth = req.headers.authorization;

  if (!auth || !auth.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ ok: false, error: "Missing Authorization header" });
  }

  const token = auth.slice(7);

  let payload;
  try {
    payload = jwt.verify(token, STAFF_JWT_SECRET);
  } catch (err) {
    console.error("[STAFF_AUTH] token error:", err.message);
    return res
      .status(401)
      .json({ ok: false, error: "Invalid or expired staff token" });
  }

  if (payload.type !== "staff") {
    return res.status(403).json({ ok: false, error: "Not a staff token" });
  }

  // Attach to request for downstream handlers
  req.staff = {
    id: payload.sub,
    role: payload.role,
    permissions: payload.permissions || [],
  };

  next();
}

/**
 * Permission gate: require a specific permission string from the staff token.
 */
function requirePermission(permission) {
  return (req, res, next) => {
    const perms = (req.staff && req.staff.permissions) || [];
    if (!perms.includes(permission)) {
      return res
        .status(403)
        .json({ ok: false, error: "Forbidden: missing permission " + permission });
    }
    next();
  };
}

module.exports = {
  staffAuth,
  requirePermission,
};
