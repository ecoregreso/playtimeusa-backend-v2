const jwt = require('jsonwebtoken');

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const ADMIN_SECRET = process.env.JWT_SECRET;

if (!ACCESS_SECRET || !REFRESH_SECRET || !ADMIN_SECRET) {
  console.warn('[JWT] One or more JWT secrets are missing in .env');
}

function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      type: 'access',
    },
    ACCESS_SECRET,
    { expiresIn: '15m' }
  );
}

function signRefreshToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      type: 'refresh',
    },
    REFRESH_SECRET,
    { expiresIn: '7d' }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_SECRET);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, REFRESH_SECRET);
}

function signAdminToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      type: 'admin',
    },
    ADMIN_SECRET,
    { expiresIn: '1h' }
  );
}

function verifyAdminToken(token) {
  return jwt.verify(token, ADMIN_SECRET);
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  signAdminToken,
  verifyAdminToken,
};
