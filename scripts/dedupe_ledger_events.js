#!/usr/bin/env node
require("dotenv").config();

const { QueryTypes } = require("sequelize");
const { sequelize } = require("../src/db");

async function run() {
  try {
    await sequelize.authenticate();

    const [actionDedupe] = await sequelize.transaction(async (t) => {
      await sequelize.query("SET LOCAL app.role = 'owner'", { transaction: t });
      await sequelize.query("SET LOCAL app.tenant_id = NULL", { transaction: t });

      return sequelize.query(
        `
        WITH ranked AS (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY tenant_id, "actionId", "eventType"
              ORDER BY "createdAt" ASC, id ASC
            ) AS rn
          FROM ledger_events
          WHERE "actionId" IS NOT NULL
        ),
        deleted AS (
          DELETE FROM ledger_events
          WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
          RETURNING 1
        )
        SELECT COUNT(*)::int AS count FROM deleted;
        `,
        { type: QueryTypes.SELECT, transaction: t }
      );
    });

    const [windowDedupe] = await sequelize.transaction(async (t) => {
      await sequelize.query("SET LOCAL app.role = 'owner'", { transaction: t });
      await sequelize.query("SET LOCAL app.tenant_id = NULL", { transaction: t });

      return sequelize.query(
        `
        WITH ranked AS (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY
                tenant_id,
                "sessionId",
                "eventType",
                "gameKey",
                "amountCents",
                "betCents",
                "winCents",
                "balanceCents",
                date_trunc('second', "ts")
              ORDER BY "createdAt" ASC, id ASC
            ) AS rn
          FROM ledger_events
          WHERE "actionId" IS NULL
            AND "sessionId" IS NOT NULL
        ),
        deleted AS (
          DELETE FROM ledger_events
          WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
          RETURNING 1
        )
        SELECT COUNT(*)::int AS count FROM deleted;
        `,
        { type: QueryTypes.SELECT, transaction: t }
      );
    });

    const actionCount = Number(actionDedupe?.count || 0);
    const windowCount = Number(windowDedupe?.count || 0);

    console.log(
      `[LEDGER_DEDUPE] removed ${actionCount} actionId duplicates and ${windowCount} window duplicates.`
    );
    await sequelize.close();
  } catch (err) {
    console.error("[LEDGER_DEDUPE] error:", err);
    process.exit(1);
  }
}

run();
