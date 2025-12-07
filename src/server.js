// src/server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const reportsRoutes = require("./routes/reports");

// Route modules
const authRoutes = require("./routes/auth");
const walletRoutes = require("./routes/wallets");
const voucherRoutes = require("./routes/vouchers");
const adminPlayersRoutes = require("./routes/adminPlayers");
const staffAuthRoutes = require("./routes/staffAuth");

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN || "http://localhost:5173";

const app = express();

app.set("trust proxy", 1);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
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
app.use("/auth", authRoutes);
app.use("/wallets", walletRoutes);
app.use("/vouchers", voucherRoutes);
app.use("/admin/players", adminPlayersRoutes);
app.use("/admin/reports", reportsRoutes);
app.use("/api/v1/staff", staffAuthRoutes);

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
