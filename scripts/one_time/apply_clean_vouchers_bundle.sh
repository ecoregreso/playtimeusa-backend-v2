#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "==> Writing migration: 004_voucher_creator_audit.sql"
mkdir -p migrations
cat > migrations/004_voucher_creator_audit.sql <<'SQL'
-- 004_voucher_creator_audit.sql
-- Adds creator audit columns for vouchers (idempotent) + indexes.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='vouchers' AND column_name='createdByActorType'
  ) THEN
    ALTER TABLE "vouchers" ADD COLUMN "createdByActorType" TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='vouchers' AND column_name='createdByStaffId'
  ) THEN
    ALTER TABLE "vouchers" ADD COLUMN "createdByStaffId" INTEGER;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='vouchers' AND column_name='createdByUserId'
  ) THEN
    ALTER TABLE "vouchers" ADD COLUMN "createdByUserId" UUID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS vouchers_created_by_actor_type_idx ON vouchers ("createdByActorType");
CREATE INDEX IF NOT EXISTS vouchers_created_by_staff_id_idx ON vouchers ("createdByStaffId");
CREATE INDEX IF NOT EXISTS vouchers_created_by_user_id_idx ON vouchers ("createdByUserId");
SQL

echo "==> Writing full src/server.js"
cat > src/server.js <<'JS'
// src/server.js
require("dotenv").config();

const path = require("path");
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

// Supports comma-separated origins:
// FRONTEND_ORIGIN=http://localhost:5173,http://localhost:5174
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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

// CORS (multi-origin)
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl/postman/server-to-server
      if (FRONTEND_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

if (NODE_ENV !== "test") app.use(morgan("dev"));

// Serve exports (QR PNGs, CSVs, reports) from /exports/...
app.use("/exports", express.static(path.join(__dirname, "..", "exports")));

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
  res
    .status(err.status || 500)
    .json({ error: err.message || "Internal server error" });
});

async function start() {
  try {
    await sequelize.authenticate();
    console.log("[DB] Connected");

    if (process.env.DB_SYNC === "1") {
      await sequelize.sync({ alter: false });
      console.log("[DB] Synced models (DB_SYNC=1)");
    } else {
      console.log(
        "[DB] DB_SYNC not enabled -> skipping sequelize.sync(); run ./scripts/db/migrate.sh"
      );
    }

    app.listen(PORT, () => console.log(`[API] Listening on :${PORT}`));
  } catch (err) {
    console.error("[STARTUP] Failed:", err);
    process.exit(1);
  }
}

start();
JS

echo "==> Writing full src/models/Voucher.js"
cat > src/models/Voucher.js <<'JS'
// src/models/Voucher.js
const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/database");
const User = require("./User");

const Voucher = sequelize.define(
  "Voucher",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    code: {
      type: DataTypes.STRING(32),
      allowNull: false,
      unique: true,
    },
    pin: {
      type: DataTypes.STRING(16),
      allowNull: false,
    },
    amount: {
      type: DataTypes.DECIMAL(18, 4),
      allowNull: false,
    },
    bonusAmount: {
      type: DataTypes.DECIMAL(18, 4),
      allowNull: false,
      defaultValue: 0,
    },
    currency: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: "FUN",
    },
    status: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: "new", // new | redeemed | cancelled | expired
    },
    redeemedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    // Creator audit
    createdByActorType: { type: DataTypes.TEXT, allowNull: true },
    createdByStaffId: { type: DataTypes.INTEGER, allowNull: true },
    createdByUserId: { type: DataTypes.UUID, allowNull: true },

    // Redeemer (player)
    redeemedByUserId: { type: DataTypes.UUID, allowNull: true },

    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  },
  {
    tableName: "vouchers",
    timestamps: true,
  }
);

// created-by user
User.hasMany(Voucher, { foreignKey: { name: "createdByUserId", allowNull: true } });
Voucher.belongsTo(User, { as: "createdBy", foreignKey: { name: "createdByUserId", allowNull: true } });

// redeemed-by user
User.hasMany(Voucher, { foreignKey: { name: "redeemedByUserId", allowNull: true } });
Voucher.belongsTo(User, { as: "redeemedBy", foreignKey: { name: "redeemedByUserId", allowNull: true } });

module.exports = Voucher;
JS

echo "==> Writing full src/models/Wallet.js (fix sequelize import)"
cat > src/models/Wallet.js <<'JS'
const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/database");
const User = require("./User");

const Wallet = sequelize.define(
  "Wallet",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    balance: {
      type: DataTypes.DECIMAL(18, 4),
      allowNull: false,
      defaultValue: 0,
    },
    currency: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: "FUN",
    },
  },
  {
    tableName: "wallets",
    timestamps: true,
  }
);

User.hasOne(Wallet, {
  foreignKey: { name: "userId", allowNull: false },
  onDelete: "CASCADE",
});
Wallet.belongsTo(User, {
  foreignKey: { name: "userId", allowNull: false },
});

module.exports = Wallet;
JS

echo "==> Writing full src/models/Transaction.js (fix sequelize import)"
cat > src/models/Transaction.js <<'JS'
const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/database");
const Wallet = require("./Wallet");
const User = require("./User");

const Transaction = sequelize.define(
  "Transaction",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    type: {
      type: DataTypes.ENUM(
        "credit",
        "debit",
        "voucher_credit",
        "voucher_debit",
        "game_bet",
        "game_win",
        "manual_adjustment"
      ),
      allowNull: false,
    },
    amount: {
      type: DataTypes.DECIMAL(18, 4),
      allowNull: false,
    },
    balanceBefore: {
      type: DataTypes.DECIMAL(18, 4),
      allowNull: false,
    },
    balanceAfter: {
      type: DataTypes.DECIMAL(18, 4),
      allowNull: false,
    },
    reference: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    tableName: "transactions",
    timestamps: true,
  }
);

Wallet.hasMany(Transaction, {
  foreignKey: { name: "walletId", allowNull: false },
  onDelete: "CASCADE",
});
Transaction.belongsTo(Wallet, {
  foreignKey: { name: "walletId", allowNull: false },
});

User.hasMany(Transaction, {
  foreignKey: { name: "createdByUserId", allowNull: true },
});
Transaction.belongsTo(User, {
  as: "createdBy",
  foreignKey: { name: "createdByUserId", allowNull: true },
});

module.exports = Transaction;
JS

echo "==> Writing full src/models/GameRound.js (fix sequelize import)"
cat > src/models/GameRound.js <<'JS'
// src/models/GameRound.js
const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/database");
const User = require("./User");

const GameRound = sequelize.define(
  "GameRound",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    playerId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    gameId: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    roundIndex: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    betAmount: {
      type: DataTypes.DECIMAL(18, 4),
      allowNull: false,
    },
    winAmount: {
      type: DataTypes.DECIMAL(18, 4),
      allowNull: false,
      defaultValue: 0,
    },
    currency: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: "FUN",
    },
    status: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: "pending", // pending | settled
    },
    rtpSample: {
      type: DataTypes.DECIMAL(10, 6),
      allowNull: true,
    },
    result: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  },
  {
    tableName: "game_rounds",
    timestamps: true,
  }
);

// relations
User.hasMany(GameRound, {
  foreignKey: { name: "playerId", allowNull: false },
});
GameRound.belongsTo(User, {
  as: "player",
  foreignKey: { name: "playerId", allowNull: false },
});

module.exports = GameRound;
JS

echo "==> Writing full src/routes/vouchers.js (clean creator fields + safe responses)"
cat > src/routes/vouchers.js <<'JS'
// src/routes/vouchers.js
const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { Voucher, Wallet, Transaction } = require("../models");
const { generateVoucherQrPng } = require("../utils/qr");

const router = express.Router();

function creatorFields(req) {
  const u = (req && req.user) || {};
  const actorType = u.actorType || "user";
  const id = u.id || null;

  if (actorType === "staff") {
    const staffId = Number(id);
    return {
      createdByActorType: "staff",
      createdByStaffId: Number.isFinite(staffId) ? staffId : null,
      createdByUserId: null,
    };
  }

  return {
    createdByActorType: "user",
    createdByStaffId: null,
    createdByUserId: id,
  };
}

function randomAlphaNum(length) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function randomNumeric(length) {
  let out = "";
  for (let i = 0; i < length; i++) out += Math.floor(Math.random() * 10).toString();
  return out;
}

async function getOrCreateWallet(userId, currency = "FUN") {
  let wallet = await Wallet.findOne({ where: { userId, currency } });
  if (!wallet) {
    wallet = await Wallet.create({ userId, currency, balance: 0 });
  }
  return wallet;
}

// GET /api/v1/vouchers (admin) – list latest vouchers
router.get(
  "/",
  requireAuth,
  requireRole("owner", "operator", "agent", "cashier", "admin"),
  async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || "200", 10), 500);

      const vouchers = await Voucher.findAll({
        order: [["createdAt", "DESC"]],
        limit,
        attributes: { exclude: ["pin"] },
      });

      return res.json(vouchers);
    } catch (err) {
      console.error("[VOUCHERS] GET / error:", err);
      return res.status(500).json({ error: "Failed to list vouchers" });
    }
  }
);

// POST /api/v1/vouchers (admin) – create voucher + PIN + userCode + QR
router.post(
  "/",
  requireAuth,
  requireRole("owner", "operator", "agent", "cashier", "admin"),
  async (req, res) => {
    try {
      const { amount, bonusAmount, currency } = req.body || {};

      const valueAmount = Number(amount || 0);
      const valueBonus = Number(bonusAmount || 0);

      if (!Number.isFinite(valueAmount) || valueAmount <= 0) {
        return res.status(400).json({ error: "Invalid amount" });
      }
      if (!Number.isFinite(valueBonus) || valueBonus < 0) {
        return res.status(400).json({ error: "Invalid bonusAmount" });
      }

      const finalCurrency = String(currency || "FUN").toUpperCase();

      const pin = randomNumeric(6);
      const userCode = randomNumeric(6);

      let voucher = null;
      const maxAttempts = 8;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const code = randomAlphaNum(10);

        try {
          voucher = await Voucher.create({
            code,
            pin,
            amount: valueAmount,
            bonusAmount: valueBonus,
            currency: finalCurrency,
            status: "new",
            metadata: {
              userCode,
              source: "admin_panel",
            },

            // creator audit
            ...creatorFields(req),
          });

          break;
        } catch (e) {
          const isUnique = e && (e.name === "SequelizeUniqueConstraintError" || e.parent?.code === "23505");
          if (!isUnique || attempt === maxAttempts) throw e;
        }
      }

      let qrPath = null;
      try {
        qrPath = await generateVoucherQrPng({
          code: voucher.code,
          pin,
          userCode,
        });
      } catch (qrErr) {
        console.error("[VOUCHERS] QR generation failed:", qrErr);
      }

      if (qrPath) {
        voucher.metadata = { ...(voucher.metadata || {}), qrPath };
        await voucher.save();
      }

      const voucherSafe = voucher.toJSON();
      delete voucherSafe.pin;

      return res.status(201).json({
        voucher: voucherSafe,
        pin, // for printing / handoff
        userCode,
        qr: qrPath ? { path: qrPath } : null,
      });
    } catch (err) {
      console.error("[VOUCHERS] POST / error:", err);
      return res.status(500).json({ error: "Failed to create voucher" });
    }
  }
);

// POST /api/v1/vouchers/redeem (player) – redeem voucher into wallet
router.post(
  "/redeem",
  requireAuth,
  requireRole("player"),
  async (req, res) => {
    try {
      const { code, pin } = req.body || {};

      if (!code || !pin) {
        return res.status(400).json({ error: "code and pin are required" });
      }

      const voucher = await Voucher.findOne({
        where: { code, pin, status: "new" },
      });

      if (!voucher) {
        return res.status(404).json({ error: "Voucher not found" });
      }

      if (voucher.expiresAt && new Date(voucher.expiresAt) < new Date()) {
        return res.status(400).json({ error: "Voucher expired" });
      }

      const userId = req.user.id;
      const currency = voucher.currency || "FUN";

      const wallet = await getOrCreateWallet(userId, currency);

      const before = Number(wallet.balance || 0);
      const amount = Number(voucher.amount || 0);
      const bonus = Number(voucher.bonusAmount || 0);
      const totalCredit = amount + bonus;

      wallet.balance = before + totalCredit;
      await wallet.save();

      const tx = await Transaction.create({
        walletId: wallet.id,
        type: "voucher_credit",
        amount: totalCredit,
        balanceBefore: before,
        balanceAfter: wallet.balance,
        reference: `voucher:${voucher.code}`,
        metadata: { voucherId: voucher.id, amount, bonus },
        createdByUserId: userId,
      });

      voucher.status = "redeemed";
      voucher.redeemedAt = new Date();
      voucher.redeemedByUserId = userId;
      await voucher.save();

      const voucherSafe = voucher.toJSON();
      delete voucherSafe.pin;

      return res.json({
        voucher: voucherSafe,
        wallet,
        transaction: tx,
      });
    } catch (err) {
      console.error("[VOUCHERS] POST /redeem error:", err);
      return res.status(500).json({ error: "Failed to redeem voucher" });
    }
  }
);

module.exports = router;
JS

echo "==> Applying migrations"
./scripts/db/migrate.sh

echo "==> Done. Restart nodemon (type: rs) if it's running."
