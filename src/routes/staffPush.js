const express = require("express");
const crypto = require("crypto");
const { staffAuth } = require("../middleware/staffAuth");
const { StaffPushDevice } = require("../models");
const { encryptString } = require("../utils/pushCrypto");
const { sendPushToStaffIds } = require("../utils/push");

const router = express.Router();

const ALLOWED_ROLES = new Set(["owner", "agent", "operator", "distributor"]);

function requirePushRole(req, res, next) {
  if (!ALLOWED_ROLES.has(req.staff?.role)) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }
  return next();
}

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

// Get VAPID public key (for web push)
router.get("/vapid-public", staffAuth, requirePushRole, (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(500).json({ ok: false, error: "VAPID not configured" });
  return res.json({ ok: true, publicKey: key });
});

// List own devices
router.get("/devices", staffAuth, requirePushRole, async (req, res) => {
  try {
    const devices = await StaffPushDevice.findAll({
      where: { staffId: req.staff.id, tenantId: req.staff?.tenantId || null },
      order: [["createdAt", "DESC"]],
    });
    return res.json({
      ok: true,
      devices: devices.map((d) => ({
        id: d.id,
        deviceType: d.deviceType,
        label: d.label,
        platform: d.platform,
        isActive: d.isActive,
        createdAt: d.createdAt,
        lastUsedAt: d.lastUsedAt,
      })),
    });
  } catch (err) {
    console.error("[PUSH] list devices error:", err);
    return res.status(500).json({ ok: false, error: "Failed to list devices" });
  }
});

// Register a device
router.post("/register", staffAuth, requirePushRole, async (req, res) => {
  try {
    const deviceType = String(req.body?.deviceType || "").trim();
    const label = String(req.body?.label || "").trim();
    const platform = String(req.body?.platform || "").trim();
    const subscription = req.body?.subscription;
    const token = req.body?.token;

    if (!["web", "fcm", "apns"].includes(deviceType)) {
      return res.status(400).json({ ok: false, error: "Invalid deviceType" });
    }

    let raw = "";
    if (deviceType === "web") {
      if (!subscription) {
        return res.status(400).json({ ok: false, error: "subscription required" });
      }
      raw = typeof subscription === "string" ? subscription : JSON.stringify(subscription);
    } else {
      if (!token) {
        return res.status(400).json({ ok: false, error: "token required" });
      }
      raw = String(token).trim();
    }

    const tokenHash = hashToken(raw);
    const encryptedToken = encryptString(raw);
    const tenantId = req.staff?.tenantId || null;

    const existing = await StaffPushDevice.findOne({
      where: {
        staffId: req.staff.id,
        tenantId,
        deviceType,
        tokenHash,
      },
    });

    if (existing) {
      await existing.update({
        label: label || existing.label,
        platform: platform || existing.platform,
        encryptedToken,
        isActive: true,
        lastUsedAt: new Date(),
      });
      return res.json({ ok: true, deviceId: existing.id });
    }

    const created = await StaffPushDevice.create({
      staffId: req.staff.id,
      tenantId,
      deviceType,
      label: label || null,
      platform: platform || null,
      tokenHash,
      encryptedToken,
      lastUsedAt: new Date(),
    });

    return res.status(201).json({ ok: true, deviceId: created.id });
  } catch (err) {
    console.error("[PUSH] register error:", err);
    return res.status(500).json({ ok: false, error: "Failed to register device" });
  }
});

// Delete a device
router.delete("/devices/:id", staffAuth, requirePushRole, async (req, res) => {
  try {
    const device = await StaffPushDevice.findByPk(req.params.id);
    if (!device) return res.status(404).json({ ok: false, error: "Not found" });
    if (device.staffId !== req.staff.id || device.tenantId !== req.staff?.tenantId) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }
    await device.destroy();
    return res.json({ ok: true });
  } catch (err) {
    console.error("[PUSH] delete device error:", err);
    return res.status(500).json({ ok: false, error: "Failed to delete device" });
  }
});

// Send a test notification
router.post("/test", staffAuth, requirePushRole, async (req, res) => {
  try {
    const tenantId = req.staff?.tenantId || null;
    const result = await sendPushToStaffIds({
      tenantId,
      staffIds: [req.staff.id],
      title: "Test notification",
      body: "Push is configured successfully.",
      data: { type: "test" },
    });
    return res.json({ ok: true, result });
  } catch (err) {
    console.error("[PUSH] test error:", err);
    return res.status(500).json({ ok: false, error: "Failed to send test" });
  }
});

module.exports = router;
