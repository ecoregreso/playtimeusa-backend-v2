// src/server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const auditContext = require("./middleware/auditContext");
const { logEvent } = require("./services/auditService");
const reportsRoutes = require("./routes/adminReports");
const analyticsRoutes = require("./routes/adminAnalytics");
const safetyRoutes = require("./routes/safety");
const adminSafetyRoutes = require("./routes/adminSafety");

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
const gamesRoutes = require("./routes/games");
const ownerTenantsRoutes = require("./routes/ownerTenants");
const {
  StaffUser,
  StaffKey,
  StaffMessage,
  StaffPushDevice,
  PurchaseOrder,
  PurchaseOrderMessage,
  OwnerSetting,
  LedgerEvent,
  SessionSnapshot,
  GameConfig,
  SupportTicket,
  PlayerSafetyLimit,
  PlayerSafetyAction,
} = require("./models");
const { Op } = require("sequelize");
const { buildRequestMeta, recordLedgerEvent } = require("./services/ledgerService");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";

const parseBrandValue = (value) => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (err) {
    if (NODE_ENV !== "test") {
      console.warn("[BRAND] invalid JSON value");
    }
    return null;
  }
};

const resolveBrand = async () => {
  const fromEnv = parseBrandValue(process.env.BRAND_JSON);
  if (fromEnv) return fromEnv;
  try {
    const row = await OwnerSetting.findByPk("brand");
    return parseBrandValue(row?.value);
  } catch (err) {
    if (NODE_ENV !== "test") {
      console.warn("[BRAND] lookup failed:", err.message || err);
    }
    return null;
  }
};
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
app.use(auditContext);

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

app.use((req, res, next) => {
  res.on("finish", async () => {
    if (res.statusCode < 400) return;
    const tenantId = req.auth?.tenantId || req.user?.tenantId || req.staff?.tenantId || null;
    if (!tenantId) return;
    try {
      await recordLedgerEvent({
        ts: new Date(),
        playerId: req.user?.id || null,
        eventType: "ERROR",
        actionId: crypto.randomUUID(),
        source: "api.error",
        meta: {
          ...buildRequestMeta(req),
          route: req.originalUrl,
          method: req.method,
          statusCode: res.statusCode,
          message: res.locals?.errorMessage || null,
        },
      });
    } catch (err) {
      if (NODE_ENV !== "test") {
        console.warn("[API_ERROR] failed to log error:", err.message || err);
      }
    }
  });
  next();
});

app.use((req, res, next) => {
  res.on("finish", async () => {
    const status = res.statusCode;
    if (req.originalUrl?.includes("/api/v1/staff/login")) {
      await logEvent({
        eventType: status >= 400 ? "STAFF_LOGIN_FAIL" : "STAFF_LOGIN_SUCCESS",
        success: status < 400,
        tenantId: req.body?.tenantId || null,
        requestId: req.requestId,
        actorType: "staff",
        actorUsername: req.body?.username || null,
        route: req.originalUrl,
        method: req.method,
        statusCode: status,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        meta: { source: "staff.login" },
      });
    }

    if (req.originalUrl?.includes("/api/v1/deposits/dev/mark-paid")) {
      await logEvent({
        eventType: "DEPOSIT",
        success: status < 400,
        tenantId: req.staff?.tenantId || req.auth?.tenantId || null,
        requestId: req.requestId,
        actorType: "staff",
        actorId: req.staff?.id || null,
        actorRole: req.staff?.role || null,
        actorUsername: req.staff?.username || null,
        route: req.originalUrl,
        method: req.method,
        statusCode: status,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        meta: { intentId: req.body?.intentId || null },
      });
    }

    if (req.originalUrl?.includes("/api/v1/withdrawals/dev/mark-sent")) {
      await logEvent({
        eventType: "WITHDRAW",
        success: status < 400,
        tenantId: req.staff?.tenantId || req.auth?.tenantId || null,
        requestId: req.requestId,
        actorType: "staff",
        actorId: req.staff?.id || null,
        actorRole: req.staff?.role || null,
        actorUsername: req.staff?.username || null,
        route: req.originalUrl,
        method: req.method,
        statusCode: status,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        meta: { intentId: req.body?.intentId || null },
      });
    }

    if (status !== 401 && status !== 403) {
      return;
    }

    const actor = req.staff || req.user || null;
    const actorType = req.staff ? "staff" : req.user ? "user" : null;
    const tenantId =
      req.auth?.tenantId ||
      req.staff?.tenantId ||
      req.user?.tenantId ||
      req.body?.tenantId ||
      req.body?.tenant_id ||
      null;
    const actorUsername =
      actor?.username ||
      req.body?.username ||
      req.body?.email ||
      req.body?.emailOrUsername ||
      null;

    await logEvent({
      eventType: status === 401 ? "AUTH_FAILED" : "PERMISSION_DENIED",
      success: false,
      tenantId,
      requestId: req.requestId,
      actorType,
      actorId: actor?.id || null,
      actorRole: actor?.role || null,
      actorUsername,
      route: req.originalUrl,
      method: req.method,
      statusCode: status,
      ip: req.auditContext?.ip || null,
      userAgent: req.auditContext?.userAgent || null,
      meta: {
        reason: res.locals?.errorMessage || null,
      },
    });

  });
  next();
});

// Healthcheck
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    env: NODE_ENV,
    time: new Date().toISOString(),
  });
});

app.get("/public/brand", async (req, res) => {
  const brand = await resolveBrand();
  res.json({ brand: brand || null });
});

app.get("/api/v1/public/brand", async (req, res) => {
  const brand = await resolveBrand();
  res.json({ brand: brand || null });
});

// Routes
// Backward-compatible mounts (no prefix)
app.use("/auth", authRoutes);
app.use("/wallets", walletRoutes);
app.use("/vouchers", voucherRoutes);
app.use("/admin/players", adminPlayersRoutes);
app.use("/admin/reports", reportsRoutes);
app.use("/admin/analytics", analyticsRoutes);
app.use("/admin/safety", adminSafetyRoutes);
app.use("/admin/staff", adminStaffRoutes);
app.use("/admin/transactions", adminTransactionsRoutes);
app.use("/admin/sessions", adminSessionsRoutes);
app.use("/admin/audit", adminAuditRoutes);
app.use("/player", playerRoutes);
app.use("/safety", safetyRoutes);
app.use("/games", gamesRoutes);
app.use("/deposits", financeRoutes);
app.use("/withdrawals", financeRoutes);
// Preferred v1 API mounts
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/wallets", walletRoutes);
app.use("/api/v1/vouchers", voucherRoutes);
app.use("/api/v1/admin/players", adminPlayersRoutes);
app.use("/api/v1/admin/reports", reportsRoutes);
app.use("/api/v1/admin/analytics", analyticsRoutes);
app.use("/api/v1/admin/safety", adminSafetyRoutes);
app.use("/api/v1/staff", staffAuthRoutes);
app.use("/api/v1/staff/messaging", staffMessagesRoutes);
app.use("/api/v1/staff/push", staffPushRoutes);
app.use("/api/v1/admin/staff", adminStaffRoutes);
app.use("/api/v1/admin/transactions", adminTransactionsRoutes);
app.use("/api/v1/admin/sessions", adminSessionsRoutes);
app.use("/api/v1/admin/audit", adminAuditRoutes);
app.use("/api/v1/player", playerRoutes);
app.use("/api/v1/safety", safetyRoutes);
app.use("/api/v1/games", gamesRoutes);
app.use("/api/v1", financeRoutes);
app.use("/api/v1/purchase-orders", purchaseOrdersRoutes);
app.use("/api/v1/owner", ownerTenantsRoutes);

// Sequelize sync is disabled by default; run migrations instead.
if (process.env.DB_SYNC === "true") {
  Promise.all([
    LedgerEvent.sync({ alter: true }),
    SessionSnapshot.sync({ alter: true }),
    GameConfig.sync({ alter: true }),
    SupportTicket.sync({ alter: true }),
    PlayerSafetyLimit.sync({ alter: true }),
    PlayerSafetyAction.sync({ alter: true }),
    StaffUser.sync({ alter: true }),
    StaffKey.sync({ alter: true }),
    StaffMessage.sync({ alter: true }),
    StaffPushDevice.sync({ alter: true }),
    PurchaseOrder.sync({ alter: true }),
    PurchaseOrderMessage.sync({ alter: true }),
    OwnerSetting.sync(),
  ]).catch((err) => console.error("[MSG] sync error:", err.message || err));
} else if (NODE_ENV !== "test") {
  console.log("[DB] Sequelize sync disabled. Run npm run migrate.");
}

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

if (NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`[SERVER] Listening on port ${PORT} in ${NODE_ENV} mode`);
  });
}

module.exports = app;

module.exports = app;
