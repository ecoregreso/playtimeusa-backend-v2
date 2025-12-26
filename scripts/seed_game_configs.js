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

    for (const entry of entries) {
      if (!entry.gameKey) continue;
      await GameConfig.upsert({
        gameKey: entry.gameKey,
        provider: entry.provider || null,
        expectedRtp: entry.expectedRtp || null,
        volatilityLabel: entry.volatilityLabel || null,
      });
    }

    console.log(`[GAME_CONFIG] Seeded ${entries.length} configs.`);
    await sequelize.close();
  } catch (err) {
    console.error("[GAME_CONFIG] seed error:", err);
    process.exit(1);
  }
}

run();
