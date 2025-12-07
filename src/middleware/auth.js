const jwt = require('jsonwebtoken');

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const ADMIN_SECRET = process.env.JWT_SECRET;

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    return header.slice(7);
  }
  return null;
}

function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  try {
    const payload = jwt.verify(token, ACCESS_SECRET);
    if (payload.type !== 'access') {
      return res.status(401).json({ error: 'Invalid token type' });
    }
    req.user = {
      id: payload.sub,
      role: payload.role,
    };
    next();
  } catch (err) {
    console.error('[AUTH] Access token error:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
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
    const payload = jwt.verify(token, ADMIN_SECRET);
    if (payload.type !== 'admin') {
      return res.status(401).json({ error: 'Invalid admin token type' });
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
