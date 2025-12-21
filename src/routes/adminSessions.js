// src/routes/adminSessions.js
const express = require("express");
const { Op } = require("sequelize");

const { Session } = require("../models");
const {
  staffAuth,
  requirePermission,
} = require("../middleware/staffAuth");
const { PERMISSIONS } = require("../constants/permissions");

const router = express.Router();

// GET /api/v1/admin/sessions
router.get(
  "/",
  staffAuth,
  requirePermission(PERMISSIONS.PLAYER_READ),
  async (req, res) => {
    try {
      const actorType = (req.query.actorType || "all").toLowerCase();
      const status = (req.query.status || "all").toLowerCase();
      const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);

      const where = {};
      if (actorType !== "all") where.actorType = actorType === "user" ? "user" : "staff";
      if (status === "active") where.revokedAt = { [Op.is]: null };
      if (status === "revoked") where.revokedAt = { [Op.not]: null };

      const sessions = await Session.findAll({
        where,
        order: [["lastSeenAt", "DESC"]],
        limit,
      });

      res.json({ ok: true, sessions });
    } catch (err) {
      console.error("[ADMIN_SESSIONS] list error:", err);
      res.status(500).json({ ok: false, error: "Failed to load sessions" });
    }
  }
);

// POST /api/v1/admin/sessions/:id/revoke
router.post("/:id/revoke", staffAuth, async (req, res) => {
  try {
    const session = await Session.findByPk(req.params.id);
    if (!session) {
      return res.status(404).json({ ok: false, error: "Session not found" });
    }

    // Permission gate per actor type
    const perms = new Set(req.staff.permissions || []);
    if (session.actorType === "staff" && !perms.has(PERMISSIONS.STAFF_MANAGE)) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }
    if (session.actorType === "user" && !perms.has(PERMISSIONS.PLAYER_WRITE)) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    session.revokedAt = new Date();
    await session.save();

    res.json({ ok: true });
  } catch (err) {
    console.error("[ADMIN_SESSIONS] revoke error:", err);
    res.status(500).json({ ok: false, error: "Failed to revoke session" });
  }
});

module.exports = router;
