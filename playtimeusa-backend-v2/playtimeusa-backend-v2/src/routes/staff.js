// src/routes/staff.js
const express = require("express");
const router = express.Router();
const { StaffUser } = require("../models");
const {
  authenticateStaff,
  createStaffUser,
} = require("../services/staffAuthService");
const { requireStaffAuth, PERMISSIONS } = require("../middleware/staffAuth");

// POST /api/v1/staff/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const { token, staff } = await authenticateStaff({ email, password });
    res.json({ ok: true, token, staff });
  } catch (err) {
    console.warn("[STAFF_LOGIN] error:", err.message);
    res.status(401).json({ ok: false, error: err.message });
  }
});

// GET /api/v1/staff/me
router.get("/me", requireStaffAuth(), async (req, res) => {
  res.json({ ok: true, staff: req.staff });
});

// POST /api/v1/staff/users  (operator/staff manager only)
router.post(
  "/users",
  requireStaffAuth([PERMISSIONS.STAFF_MANAGE]),
  async (req, res) => {
    try {
      const staff = await createStaffUser(req.body || {});
      res.status(201).json({ ok: true, staff });
    } catch (err) {
      console.error("[STAFF_CREATE] error:", err);
      res.status(400).json({ ok: false, error: err.message });
    }
  }
);

// GET /api/v1/staff/users
router.get(
  "/users",
  requireStaffAuth([PERMISSIONS.STAFF_MANAGE]),
  async (req, res) => {
    try {
      const list = await StaffUser.findAll({
        order: [["createdAt", "DESC"]],
        attributes: {
          exclude: ["passwordHash"],
        },
      });
      res.json({ ok: true, users: list });
    } catch (err) {
      console.error("[STAFF_LIST] error:", err);
      res.status(500).json({ ok: false, error: "Failed to list staff" });
    }
  }
);

module.exports = router;
