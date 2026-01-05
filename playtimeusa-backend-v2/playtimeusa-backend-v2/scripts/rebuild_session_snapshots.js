#!/usr/bin/env node
require("dotenv").config();

const { sequelize } = require("../src/db");
const { LedgerEvent, SessionSnapshot } = require("../src/models");

async function run() {
  try {
    await sequelize.authenticate();

    const rows = await sequelize.transaction(async (t) => {
      await sequelize.query("SET LOCAL app.role = 'owner'", { transaction: t });
      await sequelize.query("SET LOCAL app.tenant_id = NULL", { transaction: t });

      return sequelize.query(
        `
        SELECT
          tenant_id AS "tenantId",
          "sessionId",
          "playerId",
          MIN("ts") AS "startedAt",
          MAX("ts") AS "endedAt",
          SUM(CASE WHEN "eventType" = 'BET' THEN COALESCE("betCents", 0) ELSE 0 END) AS "totalBetsCents",
          SUM(CASE WHEN "eventType" = 'WIN' THEN COALESCE("winCents", 0) ELSE 0 END) AS "totalWinsCents",
          COUNT(DISTINCT "gameKey") AS "gameCount",
          COUNT(*) FILTER (WHERE "eventType" = 'SPIN') AS "spins"
        FROM ledger_events
        WHERE "sessionId" IS NOT NULL
        GROUP BY tenant_id, "sessionId", "playerId"
        `,
        { type: sequelize.QueryTypes.SELECT, transaction: t }
      );
    });

    await sequelize.transaction(async (t) => {
      await sequelize.query("SET LOCAL app.role = 'owner'", { transaction: t });
      await sequelize.query("SET LOCAL app.tenant_id = NULL", { transaction: t });
      await SessionSnapshot.destroy({ where: {}, truncate: true, transaction: t });

      if (rows.length) {
        const payload = rows.map((row) => {
          const bets = Number(row.totalBetsCents || 0);
          const wins = Number(row.totalWinsCents || 0);
          return {
            tenantId: row.tenantId,
            sessionId: row.sessionId,
            playerId: row.playerId,
            startedAt: row.startedAt,
            endedAt: row.endedAt,
            totalBetsCents: bets,
            totalWinsCents: wins,
            netCents: wins - bets,
            gameCount: Number(row.gameCount || 0),
            spins: Number(row.spins || 0),
          };
        });
        await SessionSnapshot.bulkCreate(payload, { transaction: t });
      }
    });

    console.log(`[SESSION_SNAPSHOT] rebuilt ${rows.length} sessions`);
    await sequelize.close();
  } catch (err) {
    console.error("[SESSION_SNAPSHOT] rebuild error:", err);
    process.exit(1);
  }
}

run();
