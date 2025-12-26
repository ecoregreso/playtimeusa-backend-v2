const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const {
  PlayerSafetyLimit,
  PlayerSafetyAction,
} = require("../models");
const safetyEngine = require("../services/playerSafetyEngine");

const router = express.Router();

function getSessionId(req) {
  const raw = req.get("x-session-id") || req.headers["x-session-id"];
  if (!raw) return null;
  return String(raw);
}

router.post(
  "/loss-limit",
  requireAuth,
  requireRole("player"),
  async (req, res) => {
    try {
      const sessionId = getSessionId(req);
      if (!sessionId) {
        return res.status(400).json({ ok: false, error: "Missing session id" });
      }
      const playerId = req.user.id;
      const lossLimitCents = Number(req.body?.lossLimitCents);
      if (!Number.isFinite(lossLimitCents) || lossLimitCents <= 0) {
        return res
          .status(400)
          .json({ ok: false, error: "lossLimitCents must be > 0" });
      }

      const existing = await PlayerSafetyLimit.findOne({
        where: { sessionId },
      });

      if (!existing) {
        const created = await PlayerSafetyLimit.create({
          playerId,
          sessionId,
          lossLimitCents: Math.floor(lossLimitCents),
          lockedAt: new Date(),
        });
        return res.json({
          ok: true,
          lossLimitCents: created.lossLimitCents,
          locked: true,
        });
      }

      if (lossLimitCents > Number(existing.lossLimitCents || 0)) {
        return res.status(409).json({
          ok: false,
          code: "LOSS_LIMIT_LOCKED",
          error: "Loss limit cannot be increased once set.",
        });
      }

      if (lossLimitCents < Number(existing.lossLimitCents || 0)) {
        existing.lossLimitCents = Math.floor(lossLimitCents);
        await existing.save();
      }

      return res.json({
        ok: true,
        lossLimitCents: existing.lossLimitCents,
        locked: true,
      });
    } catch (err) {
      console.error("[SAFETY] loss-limit error:", err);
      return res.status(500).json({ ok: false, error: "Failed to set loss limit" });
    }
  }
);

router.post(
  "/event",
  requireAuth,
  requireRole("player"),
  async (req, res) => {
    try {
      const sessionId = getSessionId(req);
      if (!sessionId) {
        return res.status(400).json({ ok: false, error: "Missing session id" });
      }
      const playerId = req.user.id;
      const payload = req.body || {};
      const ctx = { playerId, sessionId };

      await safetyEngine.recordTelemetryEvent(ctx, payload);

      const betCents = Number(payload.betCents || 0);
      const winCents = Number(payload.winCents || 0);
      const proposedLoss = Math.max(0, betCents - winCents);

      try {
        await safetyEngine.enforceLossLimit(ctx, proposedLoss);
      } catch (err) {
        if (err?.code === "LOSS_LIMIT_REACHED") {
          await PlayerSafetyAction.create({
            playerId,
            sessionId,
            gameKey: payload.gameKey || null,
            actionType: "STOP",
            reasonCodes: ["LOSS_LIMIT_HIT"],
            severity: 5,
            details: {
              score: 100,
              band: "STOP",
              evidence: {
                lossLimitCents: err.lossLimitCents,
                currentLossCents: err.currentLossCents,
                projectedLossCents: err.projectedLossCents,
              },
            },
          });
          return res.status(403).json({
            ok: false,
            code: "LOSS_LIMIT_REACHED",
            message: "Loss limit reached for this session.",
            action: { actionType: "STOP", message: safetyEngine.ACTION_MESSAGES.STOP },
          });
        }
        throw err;
      }

      const risk = await safetyEngine.computeRisk(ctx, {});
      const action = await safetyEngine.maybeIssueAction(ctx, risk);

      if (action?.actionType) {
        const reasonCodes = risk.reasons?.length
          ? risk.reasons
          : ["RISK_SIGNAL"];
        const severity =
          action.actionType === "STOP"
            ? 5
            : action.actionType === "COOLDOWN"
            ? 4
            : 2;
        await PlayerSafetyAction.create({
          playerId,
          sessionId,
          gameKey: payload.gameKey || null,
          actionType: action.actionType,
          reasonCodes,
          severity,
          details: {
            score: risk.score,
            band: risk.band,
            evidence: risk.evidence,
            cooldownSeconds: action.cooldownSeconds || null,
          },
        });
      }

      return res.json({
        ok: true,
        risk: {
          score: risk.score,
          band: risk.band,
          reasons: risk.reasons,
        },
        action: action || null,
      });
    } catch (err) {
      console.error("[SAFETY] event error:", err);
      return res.status(500).json({ ok: false, error: "Failed to process safety event" });
    }
  }
);

module.exports = router;
