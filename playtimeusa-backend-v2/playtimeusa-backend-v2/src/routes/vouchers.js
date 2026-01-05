// src/routes/vouchers.js
const express = require("express");
const { Op } = require("sequelize");
const { sequelize } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { staffAuth } = require("../middleware/staffAuth");
const { Voucher, Wallet, Transaction, User, TenantVoucherPool } = require("../models");
const { generateVoucherQrPng } = require("../utils/qr");
const { buildRequestMeta, recordLedgerEvent, toCents } = require("../services/ledgerService");
const { applyPendingBonusIfEligible, buildBonusState } = require("../services/bonusService");
const { logEvent } = require("../services/auditService");

const router = express.Router();

function requireStaffRole(...roles) {
  return (req, res, next) => {
    if (!req.staff) return res.status(401).json({ error: "Not authenticated" });
    if (!roles.includes(req.staff.role)) {
      return res.status(403).json({ error: "Forbidden: insufficient role" });
    }
    next();
  };
}

function randomNumeric(length) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += Math.floor(Math.random() * 10).toString();
  }
  return out;
}

async function getOrCreateWallet(userId, tenantId, currency = "FUN") {
  let wallet = await Wallet.findOne({
    where: { userId, tenantId, currency },
  });

  if (!wallet) {
    wallet = await Wallet.create({
      userId,
      tenantId,
      currency,
      balance: 0,
      bonusPending: 0,
      bonusUnacked: 0,
    });
  }

  return wallet;
}

// GET /vouchers (admin) – list latest vouchers
router.get(
  "/",
  staffAuth,
  requireStaffRole("owner", "operator", "agent"),
  async (req, res) => {
    try {
      const limit = Math.min(
        parseInt(req.query.limit || "200", 10),
        500
      );

      const vouchers = await Voucher.findAll({
        order: [["createdAt", "DESC"]],
        limit,
      });

      // Normalize status casing for front-end filters
      const normalized = vouchers.map((v) => ({
        ...v.toJSON(),
        status: String(v.status || "").toLowerCase(),
      }));

      return res.json(normalized);
    } catch (err) {
      console.error("[VOUCHERS] GET / error:", err);
      return res.status(500).json({ error: "Failed to list vouchers" });
    }
  }
);

// POST /vouchers (admin) – create voucher + PIN + userCode + QR
router.post(
  "/",
  staffAuth,
  requireStaffRole("owner", "operator", "agent"),
  async (req, res) => {
    try {
      const { amount, bonusAmount, currency } = req.body;

      const valueAmount = Number(amount || 0);
      const valueBonus = Number(bonusAmount || 0);

      if (!Number.isFinite(valueAmount) || valueAmount <= 0) {
        await logEvent({
          eventType: "VOUCHER_ISSUE",
          success: false,
          tenantId: req.staff?.tenantId || null,
          requestId: req.requestId,
          actorType: "staff",
          actorId: req.staff?.id || null,
          actorRole: req.staff?.role || null,
          actorUsername: req.staff?.username || null,
          route: req.originalUrl,
          method: req.method,
          statusCode: 400,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          meta: { reason: "invalid_amount", amount, bonusAmount, currency },
        });
        return res.status(400).json({ error: "Invalid amount" });
      }

      // Keep voucher code numeric so players can log in with the visible userCode
      const code = randomNumeric(6);
      const pin = randomNumeric(6);
      const userCode = code; // mirrors code; not stored separately
      const totalCredit = valueAmount + valueBonus;

      const t = await sequelize.transaction({ transaction: req.transaction });
      let voucher;
      try {
        const tenantId = req.staff?.tenantId || null;
        const pool = await TenantVoucherPool.findOne({
          where: { tenantId },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });

        if (!pool || Number(pool.poolBalanceCents || 0) < toCents(totalCredit)) {
          await logEvent({
            eventType: "VOUCHER_ISSUE",
            success: false,
            tenantId,
            requestId: req.requestId,
            actorType: "staff",
            actorId: req.staff?.id || null,
            actorRole: req.staff?.role || null,
            actorUsername: req.staff?.username || null,
            route: req.originalUrl,
            method: req.method,
            statusCode: 400,
            ip: req.auditContext?.ip || null,
            userAgent: req.auditContext?.userAgent || null,
            meta: { reason: "insufficient_voucher_pool", amount: valueAmount, bonusAmount: valueBonus },
          });
          await t.rollback();
          return res.status(400).json({ error: "Insufficient voucher pool balance" });
        }

        pool.poolBalanceCents = Number(pool.poolBalanceCents || 0) - toCents(totalCredit);
        await pool.save({ transaction: t });

        // Retry a few times to avoid rare collision on the unique constraint
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            voucher = await Voucher.create(
              {
                tenantId,
                code: attempt === 0 ? code : randomNumeric(6),
                pin,
                amount: valueAmount,
                bonusAmount: valueBonus,
                totalCredit,
                status: "new",
                createdBy: req.staff?.id || null,
              },
              { transaction: t }
            );
            break;
          } catch (err) {
            if (err.name === "SequelizeUniqueConstraintError" && attempt < 4) {
              continue;
            }
            throw err;
          }
        }

        await t.commit();
      } catch (err) {
        await t.rollback();
        throw err;
      }

      let qrPath = null;
      try {
        qrPath = await generateVoucherQrPng({ code: voucher.code, pin, userCode });
      } catch (qrErr) {
        console.error("[VOUCHERS] QR generation failed:", qrErr);
      }

      const response = {
        voucher: {
          ...voucher.toJSON(),
          status: "new", // front-end expects lowercase
        },
        pin,       // for operator printing / handoff
        userCode,  // explicit top-level
        qr: qrPath
          ? {
              path: qrPath,
            }
          : null,
      };

      const staffMeta = buildRequestMeta(req, { staffRole: req.staff?.role || null });
      await recordLedgerEvent({
        ts: new Date(),
        eventType: "VOUCHER_ISSUED",
        actionId: voucher.id,
        agentId: req.staff?.role === "cashier" ? null : req.staff?.id || null,
        cashierId: req.staff?.role === "cashier" ? req.staff?.id || null : null,
        amountCents: toCents(valueAmount + valueBonus),
        source: "vouchers.issue",
        meta: {
          ...staffMeta,
          voucherId: voucher.id,
          amountCents: toCents(valueAmount),
          bonusCents: toCents(valueBonus),
          currency: voucher.currency || "FUN",
        },
      });

      await logEvent({
        eventType: "VOUCHER_ISSUE",
        success: true,
        tenantId: req.staff?.tenantId || null,
        requestId: req.requestId,
        actorType: "staff",
        actorId: req.staff?.id || null,
        actorRole: req.staff?.role || null,
        actorUsername: req.staff?.username || null,
        route: req.originalUrl,
        method: req.method,
        statusCode: 201,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        meta: {
          voucherId: voucher.id,
          amount: valueAmount,
          bonusAmount: valueBonus,
          currency: voucher.currency || "FUN",
        },
      });

      return res.status(201).json(response);
    } catch (err) {
      console.error("[VOUCHERS] POST / error:", err);
      await logEvent({
        eventType: "VOUCHER_ISSUE",
        success: false,
        tenantId: req.staff?.tenantId || null,
        requestId: req.requestId,
        actorType: "staff",
        actorId: req.staff?.id || null,
        actorRole: req.staff?.role || null,
        actorUsername: req.staff?.username || null,
        route: req.originalUrl,
        method: req.method,
        statusCode: 500,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        meta: { reason: "exception", message: err.message },
      });
      return res.status(500).json({ error: "Failed to create voucher" });
    }
  }
);

// POST /vouchers/redeem (player) – redeem voucher into wallet
router.post(
  "/redeem",
  requireAuth,
  requireRole("player"),
  async (req, res) => {
    try {
      const { code, pin } = req.body;

      if (!code || !pin) {
        await logEvent({
          eventType: "VOUCHER_REDEEM",
          success: false,
          tenantId: req.auth?.tenantId || null,
          requestId: req.requestId,
          actorType: "user",
          actorId: req.user?.id || null,
          actorRole: req.user?.role || null,
          actorUsername: req.user?.username || null,
          route: req.originalUrl,
          method: req.method,
          statusCode: 400,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          meta: { reason: "missing_code_or_pin" },
        });
        return res
          .status(400)
          .json({ error: "code and pin are required" });
      }

      const voucher = await Voucher.findOne({
        where: {
          code,
          pin,
          status: "new",
        },
      });

      if (!voucher) {
        await logEvent({
          eventType: "VOUCHER_REDEEM",
          success: false,
          tenantId: req.auth?.tenantId || null,
          requestId: req.requestId,
          actorType: "user",
          actorId: req.user?.id || null,
          actorRole: req.user?.role || null,
          actorUsername: req.user?.username || null,
          route: req.originalUrl,
          method: req.method,
          statusCode: 404,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          meta: { reason: "voucher_not_found", code },
        });
        await logEvent({
          eventType: "VOUCHER_VOID",
          success: false,
          tenantId: req.auth?.tenantId || null,
          requestId: req.requestId,
          actorType: "user",
          actorId: req.user?.id || null,
          actorRole: req.user?.role || null,
          actorUsername: req.user?.username || null,
          route: req.originalUrl,
          method: req.method,
          statusCode: 404,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          meta: { reason: "voucher_not_found", code },
        });
        return res.status(404).json({ error: "Voucher not found" });
      }

      if (
        voucher.expiresAt &&
        new Date(voucher.expiresAt) < new Date()
      ) {
        await logEvent({
          eventType: "VOUCHER_REDEEM",
          success: false,
          tenantId: req.auth?.tenantId || null,
          requestId: req.requestId,
          actorType: "user",
          actorId: req.user?.id || null,
          actorRole: req.user?.role || null,
          actorUsername: req.user?.username || null,
          route: req.originalUrl,
          method: req.method,
          statusCode: 400,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          meta: { reason: "voucher_expired", code, voucherId: voucher.id },
        });
        await logEvent({
          eventType: "VOUCHER_VOID",
          success: true,
          tenantId: req.auth?.tenantId || null,
          requestId: req.requestId,
          actorType: "user",
          actorId: req.user?.id || null,
          actorRole: req.user?.role || null,
          actorUsername: req.user?.username || null,
          route: req.originalUrl,
          method: req.method,
          statusCode: 400,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          meta: { reason: "voucher_expired", code, voucherId: voucher.id },
        });
        return res.status(400).json({ error: "Voucher expired" });
      }

      const userId = req.user.id;
      const currency = voucher.currency || "FUN";

      const wallet = await getOrCreateWallet(userId, req.auth?.tenantId || null, currency);

      const before = Number(wallet.balance || 0);
      const amount = Number(voucher.amount || 0);
      const bonus = Number(voucher.bonusAmount || 0);
      const totalCredit = amount + bonus;

      wallet.balance = before + amount;
      wallet.bonusPending = Number(wallet.bonusPending || 0) + bonus;
      await wallet.save();

      const tx = await Transaction.create({
        tenantId: req.auth?.tenantId || null,
        walletId: wallet.id,
        type: "voucher_credit",
        amount,
        balanceBefore: before,
        balanceAfter: wallet.balance,
        reference: `voucher:${voucher.code}`,
        metadata: {
          voucherId: voucher.id,
          amount,
          bonusPending: bonus,
        },
        createdByUserId: userId,
      });

      voucher.status = "redeemed";
      voucher.redeemedAt = new Date();
      voucher.redeemedByUserId = userId;
      await voucher.save();

      await applyPendingBonusIfEligible({
        wallet,
        transaction: null,
        reference: `bonus:${voucher.code}`,
        metadata: { voucherId: voucher.id },
      });

      const bonusState = buildBonusState(wallet);

      const sessionId = req.headers["x-session-id"] || null;
      await recordLedgerEvent({
        ts: new Date(),
        playerId: userId,
        sessionId: sessionId ? String(sessionId) : null,
        eventType: "VOUCHER_REDEEMED",
        actionId: voucher.id,
        amountCents: toCents(totalCredit),
        source: "vouchers.redeem",
        meta: {
          ...buildRequestMeta(req),
          voucherId: voucher.id,
          amountCents: toCents(amount),
          bonusCents: toCents(bonus),
          currency,
        },
      });

      await logEvent({
        eventType: "VOUCHER_REDEEM",
        success: true,
        tenantId: req.auth?.tenantId || null,
        requestId: req.requestId,
        actorType: "user",
        actorId: req.user?.id || null,
        actorRole: req.user?.role || null,
        actorUsername: req.user?.username || null,
        route: req.originalUrl,
        method: req.method,
        statusCode: 200,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        meta: {
          voucherId: voucher.id,
          code,
          amount,
          bonus,
          currency,
        },
      });

      return res.json({
        voucher,
        wallet,
        transaction: tx,
        bonus: bonusState,
      });
    } catch (err) {
      console.error("[VOUCHERS] POST /redeem error:", err);
      await logEvent({
        eventType: "VOUCHER_REDEEM",
        success: false,
        tenantId: req.auth?.tenantId || null,
        requestId: req.requestId,
        actorType: "user",
        actorId: req.user?.id || null,
        actorRole: req.user?.role || null,
        actorUsername: req.user?.username || null,
        route: req.originalUrl,
        method: req.method,
        statusCode: 500,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        meta: { reason: "exception", message: err.message },
      });
      return res
        .status(500)
        .json({ error: "Failed to redeem voucher" });
    }
  }
);

module.exports = router;
