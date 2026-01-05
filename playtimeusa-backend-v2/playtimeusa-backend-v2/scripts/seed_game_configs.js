#!/usr/bin/env node
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { sequelize } = require("../src/db");
const { GameConfig } = require("../src/models");

const CONFIG_PATH =
  process.env.GAME_CONFIG_PATH ||
  path.join(__dirname, "..", "config", "game_configs.json");

async function run() {
  try {
    await sequelize.authenticate();
    if (!fs.existsSync(CONFIG_PATH)) {
      console.log(`[GAME_CONFIG] No config file found at ${CONFIG_PATH}.`);
      process.exit(0);
    }

    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries) || !entries.length) {
      console.log("[GAME_CONFIG] Config file is empty.");
      process.exit(0);
    }

    const [tenantRows] = await sequelize.query(
      "SELECT id FROM tenants WHERE name = $1 LIMIT 1",
      { bind: ["Default"] }
    );
    const tenantId = tenantRows?.[0]?.id || null;
    if (!tenantId) {
      console.log("[GAME_CONFIG] Default tenant missing. Run migrations first.");
      process.exit(1);
    }

    await sequelize.transaction(async (t) => {
      await sequelize.query("SET LOCAL app.role = 'owner'", { transaction: t });
      await sequelize.query("SET LOCAL app.tenant_id = :tenantId", {
        transaction: t,
        replacements: { tenantId },
      });

      for (const entry of entries) {
        if (!entry.gameKey) continue;
        await GameConfig.upsert(
          {
            tenantId,
            gameKey: entry.gameKey,
            provider: entry.provider || null,
            expectedRtp: entry.expectedRtp || null,
            volatilityLabel: entry.volatilityLabel || null,
          },
          { transaction: t }
        );
      }
    });

    console.log(`[GAME_CONFIG] Seeded ${entries.length} configs.`);
    await sequelize.close();
  } catch (err) {
    console.error("[GAME_CONFIG] seed error:", err);
    process.exit(1);
  }
}

run();
