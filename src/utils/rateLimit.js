const rateLimit = require("express-rate-limit");

function buildLimiter({ windowMs = 15 * 60 * 1000, max = 20, message = "Too many requests" } = {}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: message },
  });
}

module.exports = { buildLimiter };
