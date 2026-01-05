const express = require("express");
const { requireStaffAuth, PERMISSIONS } = require("../middleware/staffAuth");
const analytics = require("../services/analyticsService");

const router = express.Router();

function extractFilters(query) {
  return {
    agentId: query.agentId || null,
    cashierId: query.cashierId || null,
    gameKey: query.gameKey || null,
    provider: query.provider || null,
    region: query.region || null,
  };
}

function buildMeta(range) {
  return {
    from: range.from,
    to: range.to,
    bucket: range.bucket,
    timezone: range.timezone,
  };
}

router.get(
  "/overview",
  requireStaffAuth([PERMISSIONS.FINANCE_READ]),
  async (req, res) => {
    try {
      const range = analytics.parseRange(req.query);
      const filters = extractFilters(req.query);
      const data = await analytics.getOverview(range, filters);
      res.json({ ok: true, range: buildMeta(range), data });
    } catch (err) {
      console.error("[ADMIN_ANALYTICS] overview error:", err);
      res.status(500).json({ ok: false, error: "Failed to load overview" });
    }
  }
);

router.get(
  "/revenue",
  requireStaffAuth([PERMISSIONS.FINANCE_READ]),
  async (req, res) => {
    try {
      const range = analytics.parseRange(req.query);
      const filters = extractFilters(req.query);
      const [ngrSeries, handleSeries, cashflow, byGame] = await Promise.all([
        analytics.getRevenueSeries(range, filters),
        analytics.getHandlePayoutSeries(range, filters),
        analytics.getDepositWithdrawalSeries(range, filters),
        analytics.getRevenueByGame(range, filters),
      ]);
      res.json({
        ok: true,
        range: buildMeta(range),
        data: {
          ngrSeries,
          handleSeries,
          cashflow,
          byGame,
        },
      });
    } catch (err) {
      console.error("[ADMIN_ANALYTICS] revenue error:", err);
      res.status(500).json({ ok: false, error: "Failed to load revenue metrics" });
    }
  }
);

router.get(
  "/players",
  requireStaffAuth([PERMISSIONS.FINANCE_READ]),
  async (req, res) => {
    try {
      const range = analytics.parseRange(req.query);
      const filters = extractFilters(req.query);
      const [
        activeUsers,
        retention,
        sessionLengths,
        betSizes,
        highValuePlayers,
        winRateOutliers,
        bonusAbuse,
        geo,
        accountVelocity,
      ] = await Promise.all([
        analytics.getActiveUsers(range, filters),
        analytics.getRetention(range, filters),
        analytics.getSessionLengthDistribution(range),
        analytics.getBetSizeDistribution(range, filters),
        analytics.getHighValuePlayers(range, filters),
        analytics.getWinRateOutliers(range, filters),
        analytics.getBonusAbuse(range, filters),
        analytics.getGeoAnomalies(range, filters),
        analytics.getAccountVelocity(range, filters),
      ]);

      const warnings = [];
      if (!bonusAbuse.configured) {
        warnings.push("Bonus abuse indicators not configured (no bonus data).");
      }

      res.json({
        ok: true,
        range: buildMeta(range),
        warnings,
        data: {
          activeUsers,
          retention,
          sessionLengths,
          betSizes,
          highValuePlayers,
          risk: {
            winRateOutliers,
            bonusAbuse,
            geo,
            accountVelocity,
          },
        },
      });
    } catch (err) {
      console.error("[ADMIN_ANALYTICS] players error:", err);
      res.status(500).json({ ok: false, error: "Failed to load player analytics" });
    }
  }
);

router.get(
  "/games",
  requireStaffAuth([PERMISSIONS.FINANCE_READ]),
  async (req, res) => {
    try {
      const range = analytics.parseRange(req.query);
      const filters = extractFilters(req.query);
      const [rtpByGame, volatility, spinVolume] = await Promise.all([
        analytics.getRtpByGame(range, filters),
        analytics.getVolatilityHeatmap(range, filters),
        analytics.getSpinVolume(range, filters),
      ]);
      res.json({
        ok: true,
        range: buildMeta(range),
        data: { rtpByGame, volatility, spinVolume },
      });
    } catch (err) {
      console.error("[ADMIN_ANALYTICS] games error:", err);
      res.status(500).json({ ok: false, error: "Failed to load game analytics" });
    }
  }
);

router.get(
  "/ops",
  requireStaffAuth([PERMISSIONS.FINANCE_READ]),
  async (req, res) => {
    try {
      const range = analytics.parseRange(req.query);
      const [errors, cashier, resolution] = await Promise.all([
        analytics.getErrorMetrics(range),
        analytics.getCashierPerformance(range),
        analytics.getResolutionTimes(range),
      ]);
      const warnings = [];
      if (!resolution.configured) {
        warnings.push("Support ticket resolution data not configured.");
      }
      res.json({
        ok: true,
        range: buildMeta(range),
        warnings,
        data: { errors, cashier, resolution },
      });
    } catch (err) {
      console.error("[ADMIN_ANALYTICS] ops error:", err);
      res.status(500).json({ ok: false, error: "Failed to load ops analytics" });
    }
  }
);

router.get(
  "/funnel",
  requireStaffAuth([PERMISSIONS.FINANCE_READ]),
  async (req, res) => {
    try {
      const range = analytics.parseRange(req.query);
      const filters = extractFilters(req.query);
      const funnel = await analytics.getFunnel(range, filters);
      res.json({ ok: true, range: buildMeta(range), data: { funnel } });
    } catch (err) {
      console.error("[ADMIN_ANALYTICS] funnel error:", err);
      res.status(500).json({ ok: false, error: "Failed to load funnel" });
    }
  }
);

router.get(
  "/ltv",
  requireStaffAuth([PERMISSIONS.FINANCE_READ]),
  async (req, res) => {
    try {
      const range = analytics.parseRange(req.query);
      const filters = extractFilters(req.query);
      const [segments, whale] = await Promise.all([
        analytics.getLtvSegments(range, filters),
        analytics.getWhaleDependency(range, filters),
      ]);
      res.json({
        ok: true,
        range: buildMeta(range),
        data: { segments, whale },
      });
    } catch (err) {
      console.error("[ADMIN_ANALYTICS] ltv error:", err);
      res.status(500).json({ ok: false, error: "Failed to load LTV metrics" });
    }
  }
);

router.get(
  "/attribution",
  requireStaffAuth([PERMISSIONS.FINANCE_READ]),
  async (req, res) => {
    try {
      const range = analytics.parseRange(req.query);
      const filters = extractFilters(req.query);
      const metric = String(req.query.metric || "ngr");
      const data = await analytics.getAttribution(metric, range, filters);
      res.json({ ok: true, range: buildMeta(range), data });
    } catch (err) {
      console.error("[ADMIN_ANALYTICS] attribution error:", err);
      res.status(500).json({ ok: false, error: "Failed to load attribution" });
    }
  }
);

module.exports = router;
