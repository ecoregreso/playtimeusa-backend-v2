const crypto = require("crypto");

function normalizeIp(value) {
  if (!value) return null;
  const raw = Array.isArray(value) ? value[0] : String(value);
  let ip = raw.split(",")[0].trim();
  if (ip.startsWith("::ffff:")) {
    ip = ip.slice(7);
  }
  return ip || null;
}

module.exports = function auditContext(req, res, next) {
  const incoming = req.headers["x-request-id"];
  const requestId = incoming && String(incoming).trim() ? String(incoming).trim() : crypto.randomUUID();
  const ip = normalizeIp(req.ip || req.headers["x-forwarded-for"]);

  req.requestId = requestId;
  req.auditContext = {
    requestId,
    ip,
    route: req.originalUrl,
    method: req.method,
    userAgent: req.get ? req.get("user-agent") : null,
  };

  res.setHeader("X-Request-Id", requestId);
  next();
};
