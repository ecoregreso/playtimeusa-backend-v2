const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const { hashToken } = require("./token");

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const GLOBAL_ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || "";
const DEFAULT_PLAYER_ACCESS_EXPIRES_IN = "8h";
const DEFAULT_STAFF_ACCESS_EXPIRES_IN = "15m";
const PLAYER_ACCESS_EXPIRES_IN =
  process.env.JWT_PLAYER_ACCESS_EXPIRES_IN ||
  GLOBAL_ACCESS_EXPIRES_IN ||
  DEFAULT_PLAYER_ACCESS_EXPIRES_IN;
const STAFF_ACCESS_EXPIRES_IN =
  process.env.JWT_STAFF_ACCESS_EXPIRES_IN ||
  GLOBAL_ACCESS_EXPIRES_IN ||
  DEFAULT_STAFF_ACCESS_EXPIRES_IN;

function ensureSecrets() {
  if (!ACCESS_SECRET || !REFRESH_SECRET) {
    console.warn("[JWT] Missing access/refresh secrets");
  }
}

function resolveAccessExpiresIn(user, opts = {}) {
  if (opts.expiresIn) return opts.expiresIn;
  const role = String(user?.role || "").toLowerCase();
  if (role === "player") return PLAYER_ACCESS_EXPIRES_IN;
  return STAFF_ACCESS_EXPIRES_IN;
}

function signAccessToken(user, opts = {}) {
  ensureSecrets();
  const jti = opts.jti || uuidv4();
  const payload = {
    sub: user.id,
    role: user.role,
    tenantId: user.tenantId || null,
    distributorId: user.distributorId || null,
    tokenType: "access",
    jti,
  };
  if (opts.extra && typeof opts.extra === "object") {
    Object.assign(payload, opts.extra);
  }
  const expiresIn = resolveAccessExpiresIn(user, opts);
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn });
}

function signRefreshToken(user, opts = {}) {
  ensureSecrets();
  const jti = opts.jti || uuidv4();
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      tenantId: user.tenantId || null,
      distributorId: user.distributorId || null,
      tokenType: "refresh",
      jti,
    },
    REFRESH_SECRET,
    { expiresIn: "7d" }
  );
}

function verifyAccessToken(token) {
  const payload = jwt.verify(token, ACCESS_SECRET);
  if (payload.tokenType !== "access") {
    throw new Error("Invalid token type");
  }
  return payload;
}

function verifyRefreshToken(token) {
  const payload = jwt.verify(token, REFRESH_SECRET);
  if (payload.tokenType !== "refresh") {
    throw new Error("Invalid token type");
  }
  return payload;
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashToken,
};
