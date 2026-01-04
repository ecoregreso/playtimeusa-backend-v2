const express = require("express");
const bcrypt = require("bcryptjs");
const { Tenant, StaffUser } = require("../models");
const {
  staffAuth,
  requirePermission,
  PERMISSIONS,
} = require("../middleware/staffAuth");
const { wipeTenantData } = require("../services/wipeService");

const router = express.Router();

router.use(staffAuth);

// GET /api/v1/admin/tenants
router.get("/", requirePermission(PERMISSIONS.TENANT_MANAGE), async (req, res) => {
  try {
    if (req.staff?.role === "owner") {
      const tenants = await Tenant.findAll({ order: [["createdAt", "DESC"]] });
      return res.json({ ok: true, tenants });
    }

    const tenantId = req.staff?.tenantId || null;
    if (!tenantId) {
      return res.status(403).json({ ok: false, error: "Tenant access required" });
    }

    const tenant = await Tenant.findByPk(tenantId);
    return res.json({ ok: true, tenants: tenant ? [tenant] : [] });
  } catch (err) {
    console.error("[ADMIN_TENANTS] list error:", err);
    return res.status(500).json({ ok: false, error: "Failed to list tenants" });
  }
});

// POST /api/v1/admin/tenants/:id/wipe
router.post(
  "/:id/wipe",
  requirePermission(PERMISSIONS.TENANT_MANAGE),
  async (req, res) => {
    try {
      const tenantId = String(req.params.id || "").trim();
      if (!tenantId) {
        return res.status(400).json({ ok: false, error: "tenantId is required" });
      }

      if (req.staff?.role !== "owner" && req.staff?.tenantId !== tenantId) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }

      const confirm = String(req.body?.confirm || "").trim();
      if (confirm !== `WIPE ${tenantId}`) {
        return res.status(400).json({
          ok: false,
          error: "Confirmation phrase mismatch",
          expected: `WIPE ${tenantId}`,
        });
      }

      const password = String(req.body?.password || "").trim();
      if (!password) {
        return res.status(400).json({ ok: false, error: "Password is required" });
      }

      const staff = await StaffUser.findByPk(req.staff?.id);
      if (!staff) {
        return res.status(403).json({ ok: false, error: "Staff not found" });
      }

      const ok = await bcrypt.compare(password, staff.passwordHash || "");
      if (!ok) {
        return res.status(403).json({ ok: false, error: "Invalid password" });
      }

      await wipeTenantData(tenantId, {
        transaction: req.transaction,
        resetTenantBalances: true,
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error("[ADMIN_TENANTS] wipe error:", err);
      return res.status(500).json({ ok: false, error: "Failed to wipe tenant" });
    }
  }
);

module.exports = router;
