// src/utils/qr.js
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

/**
 * Generate a PNG QR file for a voucher.
 *
 * Payload: { code, pin, userCode }
 * Returns a path relative to project root, like: "exports/qr/voucher_QWCT5E8EDG.png"
 */
async function generateVoucherQrPng({ code, pin, userCode }) {
  if (!code || !pin) {
    throw new Error("Missing code or pin for QR generation");
  }

  const payload = {
    code,
    pin,
    userCode: userCode || null,
  };

  // Project root: backend/
  const projectRoot = path.join(__dirname, "..", "..");
  const qrDir = path.join(projectRoot, "exports", "qr");

  fs.mkdirSync(qrDir, { recursive: true });

  const safeCode = String(code).replace(/[^A-Za-z0-9_-]/g, "_");
  const filename = `voucher_${safeCode}.png`;
  const filePath = path.join(qrDir, filename);

  await QRCode.toFile(filePath, JSON.stringify(payload), {
    type: "png",
    width: 512,
    margin: 2,
  });

  // Return path relative to project root so scripts/UI can use it
  const relative = path.relative(projectRoot, filePath);
  return relative.replace(/\\/g, "/");
}

module.exports = {
  generateVoucherQrPng,
};
