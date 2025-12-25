// src/server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const reportsRoutes = require("./routes/adminReports");

// Route modules
const authRoutes = require("./routes/auth");
const walletRoutes = require("./routes/wallets");
const voucherRoutes = require("./routes/vouchers");
const adminPlayersRoutes = require("./routes/adminPlayers");
const staffAuthRoutes = require("./routes/staffAuth");
const adminStaffRoutes = require("./routes/adminStaff");
const adminTransactionsRoutes = require("./routes/adminTransactions");
const adminSessionsRoutes = require("./routes/adminSessions");
const adminAuditRoutes = require("./routes/adminAudit");
const financeRoutes = require("./routes/finance");
const playerRoutes = require("./routes/playerRoutes");
const staffMessagesRoutes = require("./routes/staffMessages");
const staffPushRoutes = require("./routes/staffPush");
const purchaseOrdersRoutes = require("./routes/purchaseOrders");
const {
  StaffUser,
  StaffKey,
  StaffMessage,
  StaffPushDevice,
  PurchaseOrder,
  PurchaseOrderMessage,
  OwnerSetting,
} = require("./models");
const { Op } = require("sequelize");

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
/**
 * CORS origin list
 * - FRONTEND_ORIGIN supports comma-separated origins
 * - CORS_ORIGINS is accepted as a fallback
 * - DEFAULT_ORIGINS covers the common dev ports
 */
const DEFAULT_ORIGINS = ["http://localhost:5173", "http://localhost:5174"];
const FRONTEND_ORIGINS_RAW = (
  process.env.FRONTEND_ORIGIN ||
  process.env.CORS_ORIGINS ||
  DEFAULT_ORIGINS.join(",")
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOW_ALL = FRONTEND_ORIGINS_RAW.includes("*");
const FRONTEND_ORIGINS = [...new Set(FRONTEND_ORIGINS_RAW.filter((x) => x !== "*"))];

const app = express();

app.set("trust proxy", 1);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use(
  cors({
    origin: (origin, cb) => {
      // No origin usually means server-to-server, curl, postman
      if (!origin) return cb(null, true);

      if (ALLOW_ALL) return cb(null, true);

      if (FRONTEND_ORIGINS.includes(origin)) return cb(null, true);

      return cb(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: true,
  })
);

// Logging
if (NODE_ENV !== "test") {
  app.use(
    morgan("dev", {
      skip: (req, res) => NODE_ENV === "production" && res.statusCode < 400,
    })
  );
}

// Healthcheck
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    env: NODE_ENV,
    time: new Date().toISOString(),
  });
});

// Routes
// Backward-compatible mounts (no prefix)
app.use("/auth", authRoutes);
app.use("/wallets", walletRoutes);
app.use("/vouchers", voucherRoutes);
app.use("/admin/players", adminPlayersRoutes);
app.use("/admin/reports", reportsRoutes);
app.use("/admin/staff", adminStaffRoutes);
app.use("/admin/transactions", adminTransactionsRoutes);
app.use("/admin/sessions", adminSessionsRoutes);
app.use("/admin/audit", adminAuditRoutes);
app.use("/player", playerRoutes);
app.use("/deposits", financeRoutes);
app.use("/withdrawals", financeRoutes);
// Preferred v1 API mounts
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/wallets", walletRoutes);
app.use("/api/v1/vouchers", voucherRoutes);
app.use("/api/v1/admin/players", adminPlayersRoutes);
app.use("/api/v1/admin/reports", reportsRoutes);
app.use("/api/v1/staff", staffAuthRoutes);
app.use("/api/v1/staff/messaging", staffMessagesRoutes);
app.use("/api/v1/staff/push", staffPushRoutes);
app.use("/api/v1/admin/staff", adminStaffRoutes);
app.use("/api/v1/admin/transactions", adminTransactionsRoutes);
app.use("/api/v1/admin/sessions", adminSessionsRoutes);
app.use("/api/v1/admin/audit", adminAuditRoutes);
app.use("/api/v1/player", playerRoutes);
app.use("/api/v1", financeRoutes);
app.use("/api/v1/purchase-orders", purchaseOrdersRoutes);

// Ensure messaging tables exist without altering others
Promise.all([
  StaffUser.sync({ alter: true }),
  StaffKey.sync({ alter: true }),
  StaffMessage.sync({ alter: true }),
  StaffPushDevice.sync({ alter: true }),
  PurchaseOrder.sync({ alter: true }),
  PurchaseOrderMessage.sync({ alter: true }),
  OwnerSetting.sync(),
])
  .then(async () => {
    const models = [
      StaffUser,
      StaffKey,
      StaffMessage,
      StaffPushDevice,
      PurchaseOrder,
      PurchaseOrderMessage,
    ];
    for (const model of models) {
      try {
        await model.update(
          { tenantId: "default" },
          { where: { tenantId: null } }
        );
      } catch (err) {
        console.warn(`[TENANT_BACKFILL] ${model.name}: ${err.message || err}`);
      }
    }
  })
  .catch((err) => console.error("[MSG] sync error:", err.message || err));

// Purge messages older than 24h every hour
const PURGE_MS = 24 * 60 * 60 * 1000;
setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - PURGE_MS);
    const deleted = await StaffMessage.destroy({
      where: {
        createdAt: { [Op.lt]: cutoff },
      },
    });
    if (deleted > 0) {
      console.log(`[MSG] Purged ${deleted} messages older than 24h`);
    }
  } catch (err) {
    console.error("[MSG] Purge error:", err.message || err);
  }
}, 60 * 60 * 1000);

// 404
app.use((req, res, next) => {
  if (res.headersSent) return next();
  res.status(404).json({ error: "Not found" });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("[UNHANDLED ERROR]", err);
  if (res.headersSent) return next(err);
  res
    .status(err.status || 500)
    .json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`[SERVER] Listening on port ${PORT} in ${NODE_ENV} mode`);
});

module.exports = app;
