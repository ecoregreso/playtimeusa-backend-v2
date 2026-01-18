const express = require("express");
const { requireStaffAuth, PERMISSIONS } = require("../middleware/staffAuth");
const { getJackpotSummary } = require("../services/jackpotService");

const router = express.Router();

router.get(
  "/summary",
  requireStaffAuth([PERMISSIONS.FINANCE_READ]),
  async (req, res) => {
    try {
      const staff = req.staff || {};
      const tenantScope = staff.role === "owner" ? null : staff.tenantId || null;
      const data = await getJackpotSummary({ tenantId: tenantScope, includeGlobal: true });
      res.json({ ok: true, data });
    } catch (err) {
      console.error("[ADMIN_JACKPOTS] summary error:", err);
      res.status(500).json({ ok: false, error: "Failed to load jackpots" });
    }
  }
);

module.exports = router;
