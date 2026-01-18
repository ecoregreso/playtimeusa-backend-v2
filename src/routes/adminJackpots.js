const express = require("express");
const { requireStaffAuth, PERMISSIONS } = require("../middleware/staffAuth");
const {
  getJackpotSummary,
  updateJackpotTarget,
  triggerJackpotHit,
} = require("../services/jackpotService");

const router = express.Router();

function resolveTenantScope(staff = {}) {
  return staff.role === "owner" ? null : staff.tenantId || null;
}

router.get(
  "/summary",
  requireStaffAuth([PERMISSIONS.FINANCE_READ]),
  async (req, res) => {
    try {
      const staff = req.staff || {};
      const tenantScope = resolveTenantScope(staff);
      const data = await getJackpotSummary({ tenantId: tenantScope, includeGlobal: true });
      res.json({ ok: true, data });
    } catch (err) {
      console.error("[ADMIN_JACKPOTS] summary error:", err);
      res.status(500).json({ ok: false, error: "Failed to load jackpots" });
    }
  }
);

router.patch(
  "/:jackpotId/target",
  requireStaffAuth([PERMISSIONS.FINANCE_WRITE]),
  async (req, res) => {
    try {
      const { jackpotId } = req.params;
      const { triggerCents, targetCents, rangeMinCents, rangeMaxCents, contributionBps } = req.body || {};
      const target = triggerCents ?? targetCents;
      if (target === undefined || target === null) {
        return res.status(400).json({ ok: false, error: "triggerCents is required" });
      }

      const staff = req.staff || {};
      const tenantScope = resolveTenantScope(staff);
      const jackpot = await updateJackpotTarget({
        jackpotId,
        triggerCents: target,
        rangeMinCents,
        rangeMaxCents,
        contributionBps,
        tenantScope,
      });
      res.json({ ok: true, data: jackpot });
    } catch (err) {
      console.error("[ADMIN_JACKPOTS] update target error:", err);
      const status = err.status || 500;
      res.status(status).json({ ok: false, error: err.message || "Failed to update jackpot target" });
    }
  }
);

router.post(
  "/:jackpotId/trigger",
  requireStaffAuth([PERMISSIONS.FINANCE_WRITE]),
  async (req, res) => {
    try {
      const { jackpotId } = req.params;
      const { payoutCents, playerId, triggeredBy } = req.body || {};
      const staff = req.staff || {};
      const tenantScope = resolveTenantScope(staff);
      const result = await triggerJackpotHit({
        jackpotId,
        tenantScope,
        payoutCents,
        playerId: playerId || null,
        triggeredBy: triggeredBy || `staff:${staff.id || "manual"}`,
      });
      res.json({ ok: true, data: result });
    } catch (err) {
      console.error("[ADMIN_JACKPOTS] manual trigger error:", err);
      const status = err.status || 500;
      res.status(status).json({ ok: false, error: err.message || "Failed to trigger jackpot" });
    }
  }
);

module.exports = router;
