const express = require("express");
const { Op, QueryTypes } = require("sequelize");
const { PlayerSafetyAction } = require("../models");
const { requireStaffAuth, PERMISSIONS } = require("../middleware/staffAuth");
const {
  normalizeBucket,
  normalizeTimezone,
  bucketExpression,
} = require("../utils/timeBucket");

const router = express.Router();

function parseDateInput(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Date(`${raw}T00:00:00.000Z`);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parseRange(query = {}) {
  const bucket = normalizeBucket(query.bucket);
  const timezone = normalizeTimezone(query.timezone);
  const fromRaw = query.from || query.start || null;
  const toRaw = query.to || query.end || null;
  let startDate = parseDateInput(fromRaw);
  let endDate = parseDateInput(toRaw);

  if (!startDate && !endDate) {
    const now = new Date();
    endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - 6);
  } else if (!startDate) {
    startDate = new Date(endDate);
  } else if (!endDate) {
    endDate = new Date(startDate);
  }

  if (startDate > endDate) {
    const tmp = startDate;
    startDate = endDate;
    endDate = tmp;
  }

  const endExclusive = new Date(endDate);
  if (toRaw && /^\d{4}-\d{2}-\d{2}$/.test(String(toRaw))) {
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  } else {
    endExclusive.setTime(endExclusive.getTime() + 1);
  }

  return {
    from: startDate.toISOString(),
    to: endDate.toISOString(),
    bucket,
    timezone,
    startDate,
    endDateExclusive: endExclusive,
  };
}

function buildRangeMeta(range) {
  return {
    from: range.from,
    to: range.to,
    bucket: range.bucket,
    timezone: range.timezone,
  };
}

router.get(
  "/summary",
  requireStaffAuth([PERMISSIONS.PLAYER_READ]),
  async (req, res) => {
    try {
      const range = parseRange(req.query);
      const bucketExpr = bucketExpression("createdAt", range.bucket, range.timezone);
      const replacements = {
        startDate: range.startDate,
        endDateExclusive: range.endDateExclusive,
      };

      const actionsOverTimeSql = `
        SELECT ${bucketExpr} AS t,
          SUM(CASE WHEN "actionType" = 'NUDGE' THEN 1 ELSE 0 END) AS nudge,
          SUM(CASE WHEN "actionType" = 'COOLDOWN' THEN 1 ELSE 0 END) AS cooldown,
          SUM(CASE WHEN "actionType" = 'STOP' THEN 1 ELSE 0 END) AS stop
        FROM player_safety_actions
        WHERE "createdAt" >= :startDate AND "createdAt" < :endDateExclusive
        GROUP BY t
        ORDER BY t ASC
      `;
      const actionsByTypeSql = `
        SELECT "actionType", COUNT(*) AS count
        FROM player_safety_actions
        WHERE "createdAt" >= :startDate AND "createdAt" < :endDateExclusive
        GROUP BY "actionType"
        ORDER BY count DESC
      `;
      const actionsByReasonSql = `
        SELECT reason AS "reasonCode", COUNT(*) AS count
        FROM player_safety_actions,
          LATERAL jsonb_array_elements_text("reasonCodes") AS reason
        WHERE "createdAt" >= :startDate AND "createdAt" < :endDateExclusive
        GROUP BY reason
        ORDER BY count DESC
        LIMIT 10
      `;
      const uniquePlayersSql = `
        SELECT COUNT(DISTINCT "playerId") AS count
        FROM player_safety_actions
        WHERE "createdAt" >= :startDate AND "createdAt" < :endDateExclusive
      `;
      const sessionsSql = `
        SELECT COUNT(DISTINCT "sessionId") AS count
        FROM player_safety_actions
        WHERE "createdAt" >= :startDate AND "createdAt" < :endDateExclusive
      `;
      const lossLimitStopsSql = `
        SELECT COUNT(*) AS count
        FROM player_safety_actions
        WHERE "createdAt" >= :startDate AND "createdAt" < :endDateExclusive
          AND "actionType" = 'STOP'
          AND "reasonCodes" ? 'LOSS_LIMIT_HIT'
      `;

      const [
        actionsOverTime,
        actionsByType,
        actionsByReason,
        uniquePlayersRows,
        sessionsRows,
        lossLimitRows,
      ] = await Promise.all([
        PlayerSafetyAction.sequelize.query(actionsOverTimeSql, {
          replacements,
          type: QueryTypes.SELECT,
        }),
        PlayerSafetyAction.sequelize.query(actionsByTypeSql, {
          replacements,
          type: QueryTypes.SELECT,
        }),
        PlayerSafetyAction.sequelize.query(actionsByReasonSql, {
          replacements,
          type: QueryTypes.SELECT,
        }),
        PlayerSafetyAction.sequelize.query(uniquePlayersSql, {
          replacements,
          type: QueryTypes.SELECT,
        }),
        PlayerSafetyAction.sequelize.query(sessionsSql, {
          replacements,
          type: QueryTypes.SELECT,
        }),
        PlayerSafetyAction.sequelize.query(lossLimitStopsSql, {
          replacements,
          type: QueryTypes.SELECT,
        }),
      ]);

      res.json({
        ok: true,
        range: buildRangeMeta(range),
        data: {
          actionsOverTime: actionsOverTime.map((row) => ({
            t: row.t instanceof Date ? row.t.toISOString() : row.t,
            nudge: Number(row.nudge || 0),
            cooldown: Number(row.cooldown || 0),
            stop: Number(row.stop || 0),
          })),
          actionsByType: actionsByType.map((row) => ({
            actionType: row.actionType,
            count: Number(row.count || 0),
          })),
          actionsByReason: actionsByReason.map((row) => ({
            reasonCode: row.reasonCode,
            count: Number(row.count || 0),
          })),
          uniquePlayersAffected: Number(uniquePlayersRows[0]?.count || 0),
          sessionsAffected: Number(sessionsRows[0]?.count || 0),
          lossLimitStops: Number(lossLimitRows[0]?.count || 0),
        },
      });
    } catch (err) {
      console.error("[ADMIN_SAFETY] summary error:", err);
      res.status(500).json({ ok: false, error: "Failed to load safety summary" });
    }
  }
);

router.get(
  "/actions",
  requireStaffAuth([PERMISSIONS.PLAYER_READ]),
  async (req, res) => {
    try {
      const range = parseRange(req.query);
      const limit = Math.min(Number(req.query.limit || 50), 200);
      const offset = Math.max(Number(req.query.offset || 0), 0);

      const actions = await PlayerSafetyAction.findAll({
        where: {
          createdAt: {
            [Op.gte]: range.startDate,
            [Op.lt]: range.endDateExclusive,
          },
        },
        order: [["createdAt", "DESC"]],
        limit,
        offset,
      });

      res.json({
        ok: true,
        range: buildRangeMeta(range),
        data: {
          limit,
          offset,
          actions: actions.map((row) => row.toJSON()),
        },
      });
    } catch (err) {
      console.error("[ADMIN_SAFETY] actions error:", err);
      res.status(500).json({ ok: false, error: "Failed to load safety actions" });
    }
  }
);

module.exports = router;
