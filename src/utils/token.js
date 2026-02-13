const crypto = require("crypto");

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

module.exports = { hashToken };
