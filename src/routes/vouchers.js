// src/routes/vouchers.js
const express = require("express");
const { Op } = require("sequelize");
const { requireAuth, requireRole } = require("../middleware/auth");
const { staffAuth } = require("../middleware/staffAuth");
const { Voucher, Wallet, Transaction, User } = require("../models");
const { generateVoucherQrPng } = require("../utils/qr");

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

function randomAlphaNum(length) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function randomNumeric(length) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += Math.floor(Math.random() * 10).toString();
  }
  return out;
}

async function getOrCreateWallet(userId, currency = "FUN") {
  let wallet = await Wallet.findOne({
    where: { userId, currency },
  });

  if (!wallet) {
    wallet = await Wallet.create({
      userId,
      currency,
      balance: 0,
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
        return res.status(400).json({ error: "Invalid amount" });
      }

      const code = randomAlphaNum(6);      // keep within column limit
      const pin = randomNumeric(6);        // PIN for security
      const userCode = randomNumeric(6);   // for UI display only (not stored)
      const totalCredit = valueAmount + valueBonus;

      const voucher = await Voucher.create({
        code,
        pin,
        amount: valueAmount,
        bonusAmount: valueBonus,
        totalCredit,
        status: "NEW",
        createdBy: req.staff?.id || null,
      });

      let qrPath = null;
      try {
        qrPath = await generateVoucherQrPng({ code, pin, userCode });
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

      return res.status(201).json(response);
    } catch (err) {
      console.error("[VOUCHERS] POST / error:", err);
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
        return res.status(404).json({ error: "Voucher not found" });
      }

      if (
        voucher.expiresAt &&
        new Date(voucher.expiresAt) < new Date()
      ) {
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
        metadata: {
          voucherId: voucher.id,
          amount,
          bonus,
        },
        createdByUserId: userId,
      });

      voucher.status = "redeemed";
      voucher.redeemedAt = new Date();
      voucher.redeemedByUserId = userId;
      await voucher.save();

      return res.json({
        voucher,
        wallet,
        transaction: tx,
      });
    } catch (err) {
      console.error("[VOUCHERS] POST /redeem error:", err);
      return res
        .status(500)
        .json({ error: "Failed to redeem voucher" });
    }
  }
);

module.exports = router;
