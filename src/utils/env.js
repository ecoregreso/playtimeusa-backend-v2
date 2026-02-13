const crypto = require("crypto");

const WEAK_PATTERNS = ["test", "dev", "changeme", "placeholder", "example", "sample", "default"];

function isWeakSecret(value = "") {
  const v = String(value || "");
  if (v.length < 32) return true;
  const lower = v.toLowerCase();
  return WEAK_PATTERNS.some((p) => lower.includes(p));
}

function validateEnv() {
  const env = process.env.NODE_ENV || "development";
  if (env !== "production") return;

  const required = {
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
  };

  const errors = [];
  for (const [key, value] of Object.entries(required)) {
    if (!value) {
      errors.push(`${key} is missing`);
      continue;
    }
    if (key !== "DATABASE_URL" && isWeakSecret(value)) {
      errors.push(`${key} is too weak (min 32 chars, avoid test/dev/changeme)`);
    }
  }

  if (errors.length) {
    const message = `[BOOT] Missing/weak secrets: ${errors.join("; ")}`;
    console.error(message);
    throw new Error(message);
  }
}

module.exports = { validateEnv, isWeakSecret };
