#!/usr/bin/env bash
set -euo pipefail
cd ~/Projects/PlayTime-USA/backend

# backup
cp -a src/server.js "src/server.js.bak.$(date +%s)" 2>/dev/null || true

cat > src/server.js <<'EOF'
// src/server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const { sequelize } = require("./models");

// Route modules (existing)
const authRoutes = require("./routes/auth");
const walletRoutes = require("./routes/wallets");
const voucherRoutes = require("./routes/vouchers");
const adminPlayersRoutes = require("./routes/adminPlayers");
const reportsRoutes = require("./routes/reports");
const staffAuthRoutes = require("./routes/staffAuth");
const adminStaffRoutes = require("./routes/adminStaff");

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";

// --- Feature flag: Bitcoin (deposits/withdrawals) ---
const ENABLE_BITCOIN = process.env.ENABLE_BITCOIN === "1";
let depositsRoutes = null;
let withdrawalsRoutes = null;
if (ENABLE_BITCOIN) {
  depositsRoutes = require("./routes/deposits");
  withdrawalsRoutes = require("./routes/withdrawals");
}

const app = express();
app.set("trust proxy", 1);

// Middleware
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: true,
  })
);

if (NODE_ENV !== "test") app.use(morgan("dev"));

// Health (handy for sanity checks)
app.get("/api/v1/health", (req, res) => res.json({ ok: true }));

// Mount routes
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/wallets", walletRoutes);
app.use("/api/v1/vouchers", voucherRoutes);
app.use("/api/v1/admin/players", adminPlayersRoutes);
app.use("/api/v1/admin/reports", reportsRoutes);
app.use("/api/v1/staff", staffAuthRoutes);
app.use("/api/v1/admin/staff", adminStaffRoutes);

// Bitcoin routes (disabled unless ENABLE_BITCOIN=1)
if (ENABLE_BITCOIN) app.use("/api/v1/deposits", depositsRoutes);
if (ENABLE_BITCOIN) app.use("/api/v1/withdrawals", withdrawalsRoutes);

// 404
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// Error handler
app.use((err, req, res, next) => {
  console.error("[API] Error:", err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

async function start() {
  try {
    await sequelize.authenticate();
    console.log("[DB] Connected");

    if (process.env.DB_SYNC === "1") {
      await sequelize.sync({ alter: false });
      console.log("[DB] Synced models (DB_SYNC=1)");
    } else {
      console.log("[DB] DB_SYNC not enabled -> skipping sequelize.sync(); run ./scripts/db/migrate.sh");
    }

    app.listen(PORT, () => console.log(`[API] Listening on :${PORT}`));
  } catch (err) {
    console.error("[STARTUP] Failed:", err);
    process.exit(1);
  }
}

start();
EOF

# Ensure bitcoin flag is OFF locally
if [ -f .env ]; then
  if grep -q '^ENABLE_BITCOIN=' .env; then
    sed -i 's/^ENABLE_BITCOIN=.*/ENABLE_BITCOIN=0/' .env
  else
    echo 'ENABLE_BITCOIN=0' >> .env
  fi
else
  echo 'ENABLE_BITCOIN=0' > .env
fi

echo "[ok] Restored src/server.js and set ENABLE_BITCOIN=0"
