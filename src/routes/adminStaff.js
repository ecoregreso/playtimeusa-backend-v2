// src/routes/adminStaff.js
const express = require("express");
const bcrypt = require("bcryptjs");

const { StaffUser } = require("../models");
const {
  staffAuth,
  requirePermission,
} = require("../middleware/staffAuth");
const { PERMISSIONS } = require("../constants/permissions");

const router = express.Router();

const ALLOWED_ROLES = ["cashier", "agent", "operator", "owner"];

router.use(staffAuth);

// GET /api/v1/admin/staff
router.get("/", requirePermission(PERMISSIONS.STAFF_MANAGE), async (req, res) => {
  try {
    const staff = await StaffUser.findAll({
      order: [["createdAt", "DESC"]],
    });

    res.json({
      ok: true,
      staff: staff.map((s) => ({
        id: s.id,
        username: s.username,
        email: s.email,
        role: s.role,
        agentCode: s.agentCode,
        parentId: s.parentId,
        isActive: s.isActive,
        permissions: s.permissions,
        createdAt: s.createdAt,
      })),
    });
  } catch (err) {
    console.error("[ADMIN_STAFF] list error:", err);
    res.status(500).json({ ok: false, error: "Failed to list staff" });
  }
});

// POST /api/v1/admin/staff
router.post("/", requirePermission(PERMISSIONS.STAFF_MANAGE), async (req, res) => {
  try {
    const {
      username,
      email,
      password,
      role = "cashier",
      agentCode,
      parentId,
      isActive = true,
    } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ ok: false, error: "username and password are required" });
    }

    if (!ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({ ok: false, error: "Invalid role" });
    }

    if (role === "owner" && req.staff.role !== "owner") {
      return res.status(403).json({ ok: false, error: "Only owners can create owners" });
    }

    const existing = await StaffUser.findOne({ where: { username } });
    if (existing) {
      return res.status(409).json({ ok: false, error: "username already exists" });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);

    const staff = await StaffUser.create({
      username,
      email: email || null,
      passwordHash,
      role,
      agentCode: agentCode || null,
      parentId: parentId || null,
      isActive: !!isActive,
    });

    res.status(201).json({
      ok: true,
      staff: {
        id: staff.id,
        username: staff.username,
        email: staff.email,
        role: staff.role,
        agentCode: staff.agentCode,
        parentId: staff.parentId,
        isActive: staff.isActive,
        permissions: staff.permissions,
        createdAt: staff.createdAt,
      },
    });
  } catch (err) {
    console.error("[ADMIN_STAFF] create error:", err);
    res.status(500).json({ ok: false, error: "Failed to create staff user" });
  }
});

// PATCH /api/v1/admin/staff/:id
router.patch("/:id", requirePermission(PERMISSIONS.STAFF_MANAGE), async (req, res) => {
  try {
    const { id } = req.params;
    const { role, isActive, permissions, email } = req.body || {};

    const staff = await StaffUser.findByPk(id);
    if (!staff) {
      return res.status(404).json({ ok: false, error: "Staff user not found" });
    }

    if (role) {
      if (!ALLOWED_ROLES.includes(role)) {
        return res.status(400).json({ ok: false, error: "Invalid role" });
      }
      if (role === "owner" && req.staff.role !== "owner") {
        return res.status(403).json({ ok: false, error: "Only owners can promote to owner" });
      }
      staff.role = role;
    }

    if (isActive !== undefined) {
      staff.isActive = !!isActive;
    }

    if (permissions !== undefined) {
      staff.permissions = Array.isArray(permissions) ? permissions : staff.permissions;
    }

    if (email !== undefined) {
      staff.email = email || null;
    }

    await staff.save();

    res.json({
      ok: true,
      staff: {
        id: staff.id,
        username: staff.username,
        email: staff.email,
        role: staff.role,
        agentCode: staff.agentCode,
        parentId: staff.parentId,
        isActive: staff.isActive,
        permissions: staff.permissions,
        createdAt: staff.createdAt,
      },
    });
  } catch (err) {
    console.error("[ADMIN_STAFF] update error:", err);
    res.status(500).json({ ok: false, error: "Failed to update staff user" });
  }
});

// PATCH /api/v1/admin/staff/:id/password
router.patch("/:id/password", requirePermission(PERMISSIONS.STAFF_MANAGE), async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body || {};

    if (!password) {
      return res.status(400).json({ ok: false, error: "password is required" });
    }

    const staff = await StaffUser.findByPk(id);
    if (!staff) {
      return res.status(404).json({ ok: false, error: "Staff user not found" });
    }

    staff.passwordHash = await bcrypt.hash(String(password), 10);
    await staff.save();

    res.json({ ok: true });
  } catch (err) {
    console.error("[ADMIN_STAFF] reset password error:", err);
    res.status(500).json({ ok: false, error: "Failed to reset password" });
  }
});

module.exports = router;
