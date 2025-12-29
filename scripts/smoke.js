const { sequelize } = require("../src/db");

async function run() {
  if (!process.env.DATABASE_URL) {
    console.log("[smoke] DATABASE_URL not set; skipping db check");
    return;
  }

  await sequelize.authenticate();
  console.log("[smoke] db ok");
  await sequelize.close();
}

run().catch((err) => {
  console.error("[smoke] failed:", err.message || err);
  process.exit(1);
});
