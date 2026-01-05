#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

TS="$(date +%s)"
backup() { [[ -f "$1" ]] && cp "$1" "$1.bak.$TS" && echo "[backup] $1.bak.$TS"; }

backup src/routes/vouchers.js

echo "==> Writing migration: 005_voucher_usercode_unique_new.sql"
mkdir -p migrations
cat > migrations/005_voucher_usercode_unique_new.sql <<'SQL'
-- 005_voucher_usercode_unique_new.sql
-- Enforce unique 6-digit userCode for ACTIVE vouchers (status='new')
-- Also auto-fix any duplicates found among status='new' before adding the unique index.

DO $$
DECLARE
  r RECORD;
  newcode TEXT;
  attempts INT;
BEGIN
  -- Fix duplicates (keep the first row; reassign userCode for others)
  FOR r IN
    SELECT id
    FROM (
      SELECT
        id,
        (metadata::jsonb ->> 'userCode') AS uc,
        row_number() OVER (
          PARTITION BY (metadata::jsonb ->> 'userCode')
          ORDER BY "createdAt" NULLS LAST, id
        ) AS rn
      FROM vouchers
      WHERE status = 'new'
        AND (metadata::jsonb ? 'userCode')
    ) d
    WHERE d.rn > 1
  LOOP
    attempts := 0;
    LOOP
      attempts := attempts + 1;
      newcode := lpad((floor(random() * 1000000))::int::text, 6, '0');

      EXIT WHEN NOT EXISTS (
        SELECT 1
        FROM vouchers v
        WHERE v.status = 'new'
          AND (v.metadata::jsonb ->> 'userCode') = newcode
      );

      IF attempts > 80 THEN
        RAISE EXCEPTION 'Could not generate unique userCode for duplicate voucher rows';
      END IF;
    END LOOP;

    UPDATE vouchers
    SET metadata =
      jsonb_set(
        COALESCE(metadata::jsonb, '{}'::jsonb),
        '{userCode}',
        to_jsonb(newcode),
        true
      )::json
    WHERE id = r.id;
  END LOOP;
END $$;

-- Enforce uniqueness for active vouchers
CREATE UNIQUE INDEX IF NOT EXISTS vouchers_usercode_new_unique_idx
  ON vouchers ((metadata::jsonb ->> 'userCode'))
  WHERE status = 'new';
SQL

echo "==> Writing full src/routes/vouchers.js (DB-enforced userCode uniqueness + retry)"
cat > src/routes/vouchers.js <<'JS'
const express = require("express");
const { Op } = require("sequelize");
const { requireAuth, requireRole } = require("../middleware/auth");
const { sequelize, Voucher, Wallet, Transaction } = require("../models");
const { generateVoucherQrPng } = require("../utils/qr");

const router = express.Router();

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

function actorFromReq(req) {
  const actor = req?.user || req?.staff || {};
  const actorType = actor.actorType || (req?.staff ? "staff" : "user");
  return { actorType, actorId: actor.id || null };
}

function creatorFields(req) {
  const { actorType, actorId } = actorFromReq(req);
  return {
    createdByActorType: actorType,
    createdByStaffId: actorType === "staff" ? Number(actorId) : null,
    createdByUserId: actorType === "staff" ? null : actorId,
  };
}

async function getOrCreateWallet(userId, currency, t) {
  let wallet = await Wallet.findOne({ where: { userId, currency }, transaction: t, lock: t.LOCK.UPDATE });
  if (!wallet) wallet = await Wallet.create({ userId, currency, balance: 0 }, { transaction: t });
  return wallet;
}

// GET /api/v1/vouchers (admin) – list latest vouchers (pin NEVER returned)
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

      const finalCurrency = (currency || "FUN").toUpperCase();

      // DB guarantees userCode uniqueness among status='new' via partial unique index.
      // We just retry on 23505.
      const maxAttempts = 40;
      let voucher = null;
      let pin = null;
      let userCode = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const code = randomAlphaNum(10);
        pin = randomNumeric(6);
        userCode = randomNumeric(6);

        try {
          voucher = await Voucher.create({
            code,
            pin,
            amount: valueAmount,
            bonusAmount: valueBonus,
            currency: finalCurrency,
            status: "new",
            metadata: { userCode, source: "admin_panel" },
            ...creatorFields(req),
          });
          break;
        } catch (e) {
          // 23505 unique_violation (code collision OR userCode collision)
          if (String(e?.parent?.code) === "23505") continue;
          throw e;
        }
      }

      if (!voucher) {
        return res.status(500).json({ error: "Failed to create voucher (unique collision loop)" });
      }

      // QR path + persist into metadata
      let qrPath = null;
      try {
        qrPath = await generateVoucherQrPng({ code: voucher.code, pin, userCode });
        voucher.metadata = { ...(voucher.metadata || {}), qrPath };
        await voucher.save();
      } catch (qrErr) {
        console.error("[VOUCHERS] QR generation failed:", qrErr);
      }

      const voucherSafe = voucher.toJSON ? voucher.toJSON() : voucher;
      if (voucherSafe && typeof voucherSafe === "object") delete voucherSafe.pin;

      return res.status(201).json({
        voucher: voucherSafe,
        pin,      // returned ONCE for printing/handoff
        userCode, // returned ONCE for player credentials
        qr: qrPath ? { path: qrPath } : null,
      });
    } catch (err) {
      console.error("[VOUCHERS] POST / error:", err);
      return res.status(500).json({ error: "Failed to create voucher" });
    }
  }
);

// POST /api/v1/vouchers/redeem (player) – atomic redeem into existing logged-in player's wallet
router.post(
  "/redeem",
  requireAuth,
  requireRole("player"),
  async (req, res) => {
    try {
      const { code, pin } = req.body || {};
      if (!code || !pin) return res.status(400).json({ error: "code and pin are required" });

      const userId = req.user.id;

      const out = await sequelize.transaction(async (t) => {
        const voucher = await Voucher.findOne({
          where: { code, pin, status: "new" },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });

        if (!voucher) return { ok: false, status: 404, payload: { error: "Voucher not found" } };

        if (voucher.expiresAt && new Date(voucher.expiresAt) < new Date()) {
          return { ok: false, status: 400, payload: { error: "Voucher expired" } };
        }

        const currency = voucher.currency || "FUN";
        const wallet = await getOrCreateWallet(userId, currency, t);

        const before = Number(wallet.balance || 0);
        const amount = Number(voucher.amount || 0);
        const bonus = Number(voucher.bonusAmount || 0);
        const total = amount + bonus;

        wallet.balance = before + total;
        await wallet.save({ transaction: t });

        const tx = await Transaction.create(
          {
            walletId: wallet.id,
            type: "voucher_credit",
            amount: total,
            balanceBefore: before,
            balanceAfter: wallet.balance,
            reference: `voucher:${voucher.code}`,
            metadata: { voucherId: voucher.id, amount, bonus },
            createdByUserId: userId,
          },
          { transaction: t }
        );

        voucher.status = "redeemed";
        voucher.redeemedAt = new Date();
        voucher.redeemedByUserId = userId;
        await voucher.save({ transaction: t });

        const voucherSafe = voucher.toJSON ? voucher.toJSON() : voucher;
        if (voucherSafe && typeof voucherSafe === "object") delete voucherSafe.pin;

        return { ok: true, voucher: voucherSafe, wallet, tx };
      });

      if (!out.ok) return res.status(out.status).json(out.payload);
      return res.json({ voucher: out.voucher, wallet: out.wallet, transaction: out.tx });
    } catch (err) {
      console.error("[VOUCHERS] POST /redeem error:", err);
      return res.status(500).json({ error: "Failed to redeem voucher" });
    }
  }
);

module.exports = router;
JS

echo "==> Apply migrations"
./scripts/db/migrate.sh

echo "==> Done. Restart nodemon if needed (type: rs)."
