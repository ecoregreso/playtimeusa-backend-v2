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

      const baseWhere = {};
      if (actorType !== "all") baseWhere.actorType = actorType === "user" ? "user" : "staff";

      const listWhere = { ...baseWhere };
      if (status === "active") listWhere.revokedAt = { [Op.is]: null };
      if (status === "revoked") listWhere.revokedAt = { [Op.not]: null };

      const [sessions, totalCount, activeCount] = await Promise.all([
        Session.findAll({
          where: listWhere,
          order: [["lastSeenAt", "DESC"]],
          limit,
        }),
        Session.count({ where: baseWhere }),
        Session.count({ where: { ...baseWhere, revokedAt: { [Op.is]: null } } }),
      ]);

      const total = Number(totalCount || 0);
      const active = Number(activeCount || 0);

      res.json({
        ok: true,
        sessions,
        summary: {
          actorType,
          total,
          active,
          revoked: Math.max(0, total - active),
        },
      });
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
