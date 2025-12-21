const express = require("express");
const bcrypt = require("bcryptjs");

const { Op } = require("sequelize");
const { sequelize, User, Wallet, Voucher, Transaction } = require("../models");
const { signAccessToken, signRefreshToken } = require("../utils/jwt");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Simple ping for debugging
router.get("/ping", (req, res) => {
  res.json({
    ok: true,
    scope: "player",
    time: new Date().toISOString(),
  });
});

async function getOrCreateWallet(userId, t) {
  let wallet = await Wallet.findOne({ where: { userId }, transaction: t });
  if (!wallet) {
    wallet = await Wallet.create(
      { userId, balance: 0, currency: "FUN" },
      { transaction: t }
    );
  }
  return wallet;
}

// POST /api/v1/player/login
// Accepts voucher code + pin, creates player (if needed), redeems voucher, and returns player tokens.
router.post("/login", async (req, res) => {
  const code = (req.body?.code || req.body?.userCode || "").trim();
  const pin = (req.body?.pin || "").trim();

  if (!code || !pin) {
    return res
      .status(400)
      .json({ ok: false, error: "code and pin are required" });
  }

  try {
    const voucher = await Voucher.findOne({
      where: {
        code: { [Op.iLike]: code },
        pin: { [Op.iLike]: pin },
        status: { [Op.in]: ["new", "NEW"] },
      },
    });
    if (!voucher) {
      return res
        .status(404)
        .json({ ok: false, error: "Voucher not found or invalid pin" });
    }

    const status = String(voucher.status || "").toLowerCase();
    if (status !== "new" && status !== "redeemed") {
      return res.status(400).json({
        ok: false,
        error: `Voucher not redeemable (status=${voucher.status})`,
      });
    }

    // Ensure voucher not expired
    if (voucher.expiresAt && new Date(voucher.expiresAt) < new Date()) {
      return res.status(400).json({ ok: false, error: "Voucher expired" });
    }

    const result = await sequelize.transaction(async (t) => {
      // Create player if missing (use voucher code as username, synthetic email)
      const email = `${code.toLowerCase()}@player.playtime`;
      const passwordHash = await bcrypt.hash(pin, 10);

      const [user] = await User.findOrCreate({
        where: { username: code },
        defaults: {
          email,
          username: code,
          passwordHash,
          role: "player",
          isActive: true,
        },
        transaction: t,
      });

      const wallet = await getOrCreateWallet(user.id, t);

      // If not yet redeemed, apply credit now
      if (status !== "redeemed") {
        const before = Number(wallet.balance || 0);
        const amount = Number(voucher.amount || 0);
        const bonus = Number(voucher.bonusAmount || 0);
        const total = amount + bonus;

        wallet.balance = before + total;
        await wallet.save({ transaction: t });

        await Transaction.create(
          {
            walletId: wallet.id,
            type: "voucher_credit",
            amount: total,
            balanceBefore: before,
            balanceAfter: wallet.balance,
            reference: `voucher:${voucher.code}`,
            metadata: { voucherId: voucher.id, amount, bonus },
            createdByUserId: user.id,
          },
          { transaction: t }
        );

        voucher.status = "redeemed";
        voucher.redeemedAt = new Date();
        voucher.redeemedByUserId = user.id;
        await voucher.save({ transaction: t });
      }

      const accessToken = signAccessToken(user);
      const refreshToken = signRefreshToken(user);

      return {
        user,
        wallet,
        voucher,
        tokens: { accessToken, refreshToken },
      };
    });

    return res.json({
      ok: true,
      user: {
        id: result.user.id,
        username: result.user.username,
        role: result.user.role,
      },
      wallet: {
        id: result.wallet.id,
        balance: Number(result.wallet.balance || 0),
        currency: result.wallet.currency,
      },
      voucher: {
        id: result.voucher.id,
        code: result.voucher.code,
        status: result.voucher.status,
        redeemedAt: result.voucher.redeemedAt,
      },
      tokens: result.tokens,
    });
  } catch (err) {
    console.error("[PLAYER_LOGIN] error:", err);
    res.status(500).json({ ok: false, error: "Failed to redeem voucher" });
  }
});

// GET /api/v1/player/me (requires player access token)
router.get("/me", requireAuth, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      include: [{ model: Wallet, as: "wallet" }],
    });
    if (!user || user.role !== "player") {
      return res.status(404).json({ ok: false, error: "Player not found" });
    }
    res.json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        isActive: user.isActive,
      },
      wallet: user.wallet
        ? {
            id: user.wallet.id,
            balance: Number(user.wallet.balance || 0),
            currency: user.wallet.currency,
          }
        : null,
    });
  } catch (err) {
    console.error("[PLAYER_ME] error:", err);
    res.status(500).json({ ok: false, error: "Failed to load player" });
  }
});

module.exports = router;
