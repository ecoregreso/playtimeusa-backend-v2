const crypto = require("crypto");

function getKey() {
  const secret =
    process.env.PUSH_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    "change-me-push-key";
  return crypto.createHash("sha256").update(secret).digest();
}

function encryptString(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: enc.toString("base64"),
  });
}

function decryptString(payload) {
  const key = getKey();
  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  const iv = Buffer.from(parsed.iv, "base64");
  const tag = Buffer.from(parsed.tag, "base64");
  const data = Buffer.from(parsed.data, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}

module.exports = { encryptString, decryptString };
