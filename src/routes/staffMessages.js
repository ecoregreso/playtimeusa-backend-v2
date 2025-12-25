const express = require("express");
const { Op } = require("sequelize");
const { staffAuth } = require("../middleware/staffAuth");
const { StaffUser, StaffKey, StaffMessage } = require("../models");

const router = express.Router();

// Upsert public key for current staff user
router.post("/keys", staffAuth, async (req, res) => {
  try {
    const publicKey = String(req.body.publicKey || "").trim();
    if (!publicKey) {
      return res.status(400).json({ ok: false, error: "publicKey is required" });
    }

    const [key] = await StaffKey.upsert({
      staffId: req.staff.id,
      tenantId: req.staff?.tenantId,
      publicKey,
    });

    return res.json({ ok: true, key: { staffId: key.staffId, publicKey: key.publicKey } });
  } catch (err) {
    console.error("[STAFF_KEYS] upsert error:", err);
    return res.status(500).json({ ok: false, error: "Failed to save key" });
  }
});

// Fetch public key by username
router.get("/keys/:username", staffAuth, async (req, res) => {
  try {
    const username = String(req.params.username || "").trim();
    if (!username) {
      return res.status(400).json({ ok: false, error: "username is required" });
    }
    const user = await StaffUser.findOne({
      where: { username, tenantId: req.staff?.tenantId },
    });
    if (!user) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }
    const key = await StaffKey.findOne({
      where: { staffId: user.id, tenantId: req.staff?.tenantId },
    });
    if (!key) {
      return res.status(404).json({ ok: false, error: "Key not found" });
    }
    return res.json({
      ok: true,
      key: { username: user.username, staffId: user.id, publicKey: key.publicKey },
    });
  } catch (err) {
    console.error("[STAFF_KEYS] fetch error:", err);
    return res.status(500).json({ ok: false, error: "Failed to fetch key" });
  }
});

// Send encrypted message
router.post("/messages", staffAuth, async (req, res) => {
  try {
    const toUsername = String(req.body.to || "").trim();
    const ciphertext = String(req.body.ciphertext || "").trim();
    const type = String(req.body.type || "text").trim() || "text";
    const threadId = req.body.threadId ? String(req.body.threadId).trim() : null;

    if (!toUsername || !ciphertext) {
      return res.status(400).json({ ok: false, error: "to and ciphertext are required" });
    }

    const recipient = await StaffUser.findOne({
      where: { username: toUsername, tenantId: req.staff?.tenantId },
    });
    if (!recipient || !recipient.isActive) {
      return res.status(404).json({ ok: false, error: "Recipient not found or inactive" });
    }

      const msg = await StaffMessage.create({
        threadId,
        fromId: req.staff.id,
        toId: recipient.id,
        tenantId: req.staff?.tenantId,
        ciphertext,
        type,
        createdAt: new Date(),
      });

    return res.status(201).json({
      ok: true,
      message: {
        id: msg.id,
        threadId: msg.threadId,
        fromId: msg.fromId,
        toId: msg.toId,
        type: msg.type,
        ciphertext: msg.ciphertext,
        createdAt: msg.createdAt,
      },
    });
  } catch (err) {
    console.error("[STAFF_MSG] send error:", err);
    return res.status(500).json({ ok: false, error: "Failed to send message" });
  }
});

// List messages in a thread or with a specific user
router.get("/messages", staffAuth, async (req, res) => {
  try {
    const withUsername = req.query.with ? String(req.query.with).trim() : null;
    const threadId = req.query.threadId ? String(req.query.threadId).trim() : null;

    let where = { tenantId: req.staff?.tenantId };

    if (threadId) {
      where.threadId = threadId;
    } else if (withUsername) {
      const other = await StaffUser.findOne({
        where: { username: withUsername, tenantId: req.staff?.tenantId },
      });
      if (!other) {
        return res.status(404).json({ ok: false, error: "User not found" });
      }
      where = {
        [Op.or]: [
          { fromId: req.staff.id, toId: other.id },
          { fromId: other.id, toId: req.staff.id },
        ],
      };
    } else {
      where = {
        tenantId: req.staff?.tenantId,
        [Op.or]: [{ toId: req.staff.id }, { fromId: req.staff.id }],
      };
    }

    const messages = await StaffMessage.findAll({
      where: { ...where, tenantId: req.staff?.tenantId },
      order: [["createdAt", "ASC"]],
    });

    return res.json({
      ok: true,
      messages: messages.map((m) => ({
        id: m.id,
        threadId: m.threadId,
        fromId: m.fromId,
        toId: m.toId,
        type: m.type,
        ciphertext: m.ciphertext,
        createdAt: m.createdAt,
        readAt: m.readAt,
        fromUsername: m.fromId === req.staff.id ? req.staff.username : undefined,
        toUsername: m.toId === req.staff.id ? req.staff.username : undefined,
      })),
    });
  } catch (err) {
    console.error("[STAFF_MSG] list error:", err);
    return res.status(500).json({ ok: false, error: "Failed to list messages" });
  }
});

// Mark as read
router.post("/messages/:id/read", staffAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const msg = await StaffMessage.findByPk(id);
    if (!msg) return res.status(404).json({ ok: false, error: "Not found" });
    if (msg.toId !== req.staff.id || msg.tenantId !== req.staff?.tenantId) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }
    msg.readAt = new Date();
    await msg.save();
    return res.json({ ok: true });
  } catch (err) {
    console.error("[STAFF_MSG] read error:", err);
    return res.status(500).json({ ok: false, error: "Failed to mark read" });
  }
});

module.exports = router;
