// src/routes/staffAuth.js
const express = require("express");
const bcrypt = require("bcryptjs");

const { StaffUser, Session } = require("../models");
const {
  requireStaffAuth,
  signStaffToken,
} = require("../middleware/staffAuth");
const { ROLE_DEFAULT_PERMISSIONS } = require("../constants/permissions");
const { initTenantContext } = require("../middleware/tenantContext");

const router = express.Router();

function buildPermissions(staff) {
  const explicit = Array.isArray(staff.permissions) ? staff.permissions : [];
  if (explicit.length) return Array.from(new Set(explicit));
  return ROLE_DEFAULT_PERMISSIONS[staff.role] || [];
}

// POST /api/v1/staff/login
router.post("/login", async (req, res) => {
  try {
    const { username, password, tenantId } = req.body || {};

    if (!username || !password) {
      return res
        .status(400)
        .json({ ok: false, error: "username and password are required" });
    }

    return await initTenantContext(
      req,
      res,
      {
        tenantId: tenantId || null,
        role: tenantId ? "staff" : "owner",
        userId: null,
        allowMissingTenant: !tenantId,
      },
      async () => {
        const staff = await StaffUser.findOne({
          where: tenantId
            ? { username }
            : {
                username,
                role: "owner",
                tenantId: null,
              },
        });
        if (!staff || !staff.isActive) {
          return res.status(401).json({ ok: false, error: "Invalid credentials" });
        }

        const ok = await bcrypt.compare(password, staff.passwordHash);
        if (!ok) {
          return res.status(401).json({ ok: false, error: "Invalid credentials" });
        }

        const permissions = buildPermissions(staff);
        const token = signStaffToken({ ...staff.toJSON(), permissions });

        // record session for monitoring
        try {
          await Session.create({
            tenantId: staff.tenantId,
            actorType: "staff",
            userId: String(staff.id),
            role: staff.role,
            lastSeenAt: new Date(),
          });
        } catch (err) {
          console.warn("[STAFF_LOGIN] failed to record session:", err.message);
        }

        return res.json({
          ok: true,
          token,
          tokens: {
            accessToken: token,
          },
          staff: {
            id: staff.id,
            username: staff.username,
            role: staff.role,
            isActive: staff.isActive,
            tenantId: staff.tenantId,
            permissions,
            agentCode: staff.agentCode,
            parentId: staff.parentId,
          },
        });
      }
    );
  } catch (err) {
    console.error("[STAFF_LOGIN] error:", err);
    const status = err.status || 500;
    return res.status(status).json({ ok: false, error: err.message || "Internal error" });
  }
});

// GET /api/v1/staff/me
router.get("/me", requireStaffAuth(), async (req, res) => {
  return res.json({
    ok: true,
    staff: req.staff,
  });
});

module.exports = router;
