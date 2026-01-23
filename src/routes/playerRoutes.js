const express = require("express");
const bcrypt = require("bcryptjs");

const { Op } = require("sequelize");
const { sequelize, User, Wallet, Voucher, Transaction, Session, JackpotEvent } = require("../models");
const { applyPendingBonusIfEligible, buildBonusState } = require("../services/bonusService");
const { buildRequestMeta, recordLedgerEvent, toCents } = require("../services/ledgerService");
const { signAccessToken, signRefreshToken } = require("../utils/jwt");
const { requireAuth, requireRole } = require("../middleware/auth");
const { initTenantContext } = require("../middleware/tenantContext");
const { emitSecurityEvent, maskCode } = require("../lib/security/events");
const jackpotService = require("../services/jackpotService");

const router = express.Router();

async function resolveTenantForVoucher(code, pin) {
  if (!code || !pin) return null;
  return sequelize.transaction(async (t) => {
    await sequelize.query("SET LOCAL app.role = 'owner'", { transaction: t });
    await sequelize.query("SET LOCAL app.user_id = 'voucher_login'", { transaction: t });
    await sequelize.query("SET LOCAL app.tenant_id = ''", { transaction: t });
    const voucher = await Voucher.findOne({
      where: {
        code: { [Op.iLike]: code },
        pin: { [Op.iLike]: pin },
      },
      attributes: ["tenantId"],
      order: [["createdAt", "DESC"]],
      transaction: t,
    });
    return voucher?.tenantId || null;
  });
}

// Simple ping for debugging
router.get("/ping", (req, res) => {
  res.json({
    ok: true,
    scope: "player",
    time: new Date().toISOString(),
  });
});

// Latest jackpot win for the current player (to surface manual triggers)
router.get("/jackpots/latest", requireAuth, requireRole("player"), async (req, res) => {
  try {
    const tenantId = req.auth?.tenantId || null;
    const event = await JackpotEvent.findOne({
      where: {
        playerId: req.user.id,
        ...(tenantId ? { tenantId: { [Op.or]: [tenantId, null] } } : {}),
      },
      order: [["created_at", "DESC"]],
    });
    if (!event) return res.json({ ok: true, event: null });

    const payload = {
      id: event.id,
      jackpotId: event.jackpotId,
      jackpotType: event.metadata?.type || null,
      amountCents: Number(event.amountCents || event.amount_cents || 0),
      createdAt: event.created_at || event.createdAt || null,
      metadata: event.metadata || null,
    };
    res.json({ ok: true, event: payload });
  } catch (err) {
    console.error("[PLAYER] jackpots/latest error:", err);
    res.status(500).json({ ok: false, error: "Failed to load jackpot" });
  }
});

// Current jackpot amounts for player-facing display
router.get("/jackpots/summary", requireAuth, requireRole("player"), async (req, res) => {
  try {
    const tenantId = req.auth?.tenantId || null;
    const jackpots = await jackpotService.ensureJackpotsForTenant(tenantId);
    const payload = {};
    ["hourly", "daily", "weekly"].forEach((type) => {
      const jp = jackpots[type];
      if (!jp) return;
      payload[type] = {
        id: jp.id,
        currentPotCents: Number(jp.currentPotCents || 0),
        triggerCents: Number(jp.triggerCents || 0),
        lastHitAt: jp.lastHitAt || null,
        nextDrawAt: jp.nextDrawAt || null,
      };
    });
    res.json({ ok: true, jackpots: payload });
  } catch (err) {
    console.error("[PLAYER] jackpots/summary error:", err);
    res.status(500).json({ ok: false, error: "Failed to load jackpots" });
  }
});

async function getOrCreateWallet(userId, tenantId, t) {
  let wallet = await Wallet.findOne({
    where: { userId, tenantId },
    transaction: t,
  });
  if (!wallet) {
    wallet = await Wallet.create(
      {
        userId,
        tenantId,
        balance: 0,
        currency: "FUN",
        bonusPending: 0,
        bonusUnacked: 0,
      },
      { transaction: t }
    );
  }
  return wallet;
}

async function createPlayerSession(user, req) {
  try {
    const session = await Session.create({
      tenantId: user.tenantId,
      actorType: "user",
      userId: String(user.id),
      role: user.role,
      lastSeenAt: new Date(),
      ip: req.ip || null,
      userAgent: req.get("user-agent") || null,
    });
    return session.id;
  } catch (err) {
    console.warn("[PLAYER_LOGIN] failed to record session:", err.message);
    return null;
  }
}

async function touchPlayerSession(userId, req) {
  const raw = req.headers["x-session-id"];
  if (!raw) return;
  try {
    const session = await Session.findOne({
      where: {
        id: String(raw),
        actorType: "user",
        userId: String(userId),
        revokedAt: { [Op.is]: null },
      },
    });
    if (!session) return;
    session.lastSeenAt = new Date();
    await session.save();
  } catch (err) {
    console.warn("[PLAYER_ME] failed to touch session:", err.message);
  }
}

// POST /api/v1/player/login
// Accepts voucher code + pin, creates player (if needed), redeems voucher, and returns player tokens.
router.post("/login", async (req, res) => {
  const code = (req.body?.code || req.body?.userCode || "").trim();
  const pin = (req.body?.pin || "").trim();
  let tenantId = req.body?.tenantId || req.body?.tenant_id || null;

  if (!code || !pin) {
    emitSecurityEvent({
      tenantId: tenantId || null,
      actorType: "player",
      actorId: null,
      ip: req.auditContext?.ip || null,
      userAgent: req.auditContext?.userAgent || null,
      method: req.method,
      path: req.originalUrl,
      requestId: req.requestId,
      eventType: "player_login_failed",
      severity: 2,
      details: {
        maskedCode: maskCode(code, 2),
      },
    });
    return res
      .status(400)
      .json({ ok: false, error: "code and pin are required" });
  }

  try {
    const resolvedTenantId = await resolveTenantForVoucher(code, pin);
    if (resolvedTenantId) {
      tenantId = resolvedTenantId;
    }

    if (!tenantId) {
      emitSecurityEvent({
        tenantId: null,
        actorType: "player",
        actorId: null,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        method: req.method,
        path: req.originalUrl,
        requestId: req.requestId,
        eventType: "player_login_failed",
        severity: 2,
        details: {
          maskedCode: maskCode(code, 2),
        },
      });
      return res
        .status(404)
        .json({ ok: false, error: "Voucher not found or invalid pin" });
    }

    return await initTenantContext(
      req,
      res,
      {
        tenantId,
        role: "player",
        userId: null,
        allowMissingTenant: false,
      },
      async () => {
        // First, look for a NEW voucher (primary login path)
        let voucher = await Voucher.findOne({
          where: {
            tenantId,
            code: { [Op.iLike]: code },
            pin: { [Op.iLike]: pin },
            status: { [Op.in]: ["new", "NEW"] },
          },
        });

    // Fallback: allow re-login with existing player credentials if voucher already redeemed
    if (!voucher) {
      const user = await User.findOne({
        where: { username: code, tenantId },
        include: [{ model: Wallet, as: "wallet" }],
      });

      if (!user || user.role !== "player") {
        emitSecurityEvent({
          tenantId,
          actorType: "player",
          actorId: null,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          method: req.method,
          path: req.originalUrl,
          requestId: req.requestId,
          eventType: "player_login_failed",
          severity: 2,
          details: {
            maskedCode: maskCode(code, 2),
          },
        });
        return res
          .status(404)
          .json({ ok: false, error: "Voucher not found or invalid pin" });
      }

      const validPin = await bcrypt.compare(pin, user.passwordHash || "");
      if (!validPin) {
        emitSecurityEvent({
          tenantId,
          actorType: "player",
          actorId: user.id || null,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          method: req.method,
          path: req.originalUrl,
          requestId: req.requestId,
          eventType: "player_login_failed",
          severity: 2,
          details: {
            maskedCode: maskCode(code, 2),
          },
        });
        return res
          .status(404)
          .json({ ok: false, error: "Voucher not found or invalid pin" });
      }

      const wallet = user.wallet || (await getOrCreateWallet(user.id, tenantId));
      const bonusState = buildBonusState(wallet);
      const accessToken = signAccessToken(user);
      const refreshToken = signRefreshToken(user);
      const sessionId = await createPlayerSession(user, req);

      await recordLedgerEvent({
        ts: new Date(),
        playerId: user.id,
        sessionId,
        actionId: sessionId,
        eventType: "LOGIN",
        source: "player.login",
        meta: buildRequestMeta(req, { source: "voucher_relogin" }),
      });

      return res.json({
        ok: true,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          bonusAckRequired: bonusState.ackRequired,
          bonusAppliedMinor: bonusState.appliedMinor,
          bonusPendingMinor: bonusState.pendingMinor,
          bonusBalanceMinor: bonusState.pendingMinor,
        },
        wallet: wallet
          ? {
              id: wallet.id,
              balance: Number(wallet.balance || 0),
              currency: wallet.currency,
              bonusPending: Number(wallet.bonusPending || 0),
              bonusUnacked: Number(wallet.bonusUnacked || 0),
            }
          : null,
        voucher: null,
        bonus: bonusState,
        tokens: { accessToken, refreshToken },
        sessionId,
      });
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

    let redeemMeta = null;
    const result = await sequelize.transaction({ transaction: req.transaction }, async (t) => {
      // Create player if missing (use voucher code as username, synthetic email)
      const email = `${code.toLowerCase()}@player.playtime`;
      const passwordHash = await bcrypt.hash(pin, 10);

      const [user] = await User.findOrCreate({
        where: { username: code, tenantId },
        defaults: {
          tenantId,
          email,
          username: code,
          passwordHash,
          role: "player",
          isActive: true,
        },
        transaction: t,
      });

      const wallet = await getOrCreateWallet(user.id, tenantId, t);

      // If not yet redeemed, apply credit now
      if (status !== "redeemed") {
        const before = Number(wallet.balance || 0);
        const amount = Number(voucher.amount || 0);
        const bonus = Number(voucher.bonusAmount || 0);
        redeemMeta = { voucherId: voucher.id, amount, bonus };

        wallet.balance = before + amount;
        wallet.bonusPending = Number(wallet.bonusPending || 0) + bonus;
        await wallet.save({ transaction: t });

        await Transaction.create(
          {
            tenantId,
            walletId: wallet.id,
            type: "voucher_credit",
            amount,
            balanceBefore: before,
            balanceAfter: wallet.balance,
            reference: `voucher:${voucher.code}`,
            metadata: { voucherId: voucher.id, amount, bonusPending: bonus },
            createdByUserId: user.id,
          },
          { transaction: t }
        );

        voucher.status = "redeemed";
        voucher.redeemedAt = new Date();
        voucher.redeemedByUserId = user.id;
        await voucher.save({ transaction: t });
      }

      const bonusResult = await applyPendingBonusIfEligible({
        wallet,
        transaction: t,
        reference: `bonus:${voucher.code}`,
        metadata: { voucherId: voucher.id },
      });

      const accessToken = signAccessToken(user);
      const refreshToken = signRefreshToken(user);

      return {
        user,
        wallet,
        voucher,
        tokens: { accessToken, refreshToken },
        bonusResult,
      };
    });

    const bonusState = buildBonusState(result.wallet);

    const sessionId = await createPlayerSession(result.user, req);
    const loginMeta = buildRequestMeta(req, { source: "voucher_login" });

    await recordLedgerEvent({
      ts: new Date(),
      playerId: result.user.id,
      sessionId,
      actionId: sessionId,
      eventType: "LOGIN",
      source: "player.login",
      meta: loginMeta,
    });

    if (redeemMeta) {
      await recordLedgerEvent({
        ts: new Date(),
        playerId: result.user.id,
        sessionId,
        actionId: redeemMeta.voucherId,
        eventType: "VOUCHER_REDEEMED",
        amountCents: toCents(redeemMeta.amount + redeemMeta.bonus),
        source: "player.voucher_redeem",
        meta: {
          ...loginMeta,
          voucherId: redeemMeta.voucherId,
          amountCents: toCents(redeemMeta.amount),
          bonusCents: toCents(redeemMeta.bonus),
        },
      });
    }

        return res.json({
          ok: true,
          user: {
            id: result.user.id,
            username: result.user.username,
            role: result.user.role,
            bonusAckRequired: bonusState.ackRequired,
            bonusAppliedMinor: bonusState.appliedMinor,
            bonusPendingMinor: bonusState.pendingMinor,
            bonusBalanceMinor: bonusState.pendingMinor,
          },
          wallet: {
            id: result.wallet.id,
            balance: Number(result.wallet.balance || 0),
            currency: result.wallet.currency,
            bonusPending: Number(result.wallet.bonusPending || 0),
            bonusUnacked: Number(result.wallet.bonusUnacked || 0),
          },
          voucher: {
            id: result.voucher.id,
            code: result.voucher.code,
            status: result.voucher.status,
            redeemedAt: result.voucher.redeemedAt,
          },
          bonus: bonusState,
          tokens: result.tokens,
          sessionId,
        });
      }
    );
  } catch (err) {
    console.error("[PLAYER_LOGIN] error:", err);
    const status = err.status || 500;
    res.status(status).json({ ok: false, error: err.message || "Failed to redeem voucher" });
  }
});

// POST /api/v1/player/logout
// Revokes the active session so it no longer counts as live.
router.post("/logout", requireAuth, async (req, res) => {
  try {
    const rawSessionId = req.headers["x-session-id"] || req.body?.sessionId || null;
    const sessionId = rawSessionId ? String(rawSessionId).trim() : null;
    const now = new Date();

    const baseWhere = {
      actorType: "user",
      userId: String(req.user.id),
      revokedAt: { [Op.is]: null },
    };
    if (req.user.tenantId) {
      baseWhere.tenantId = req.user.tenantId;
    }

    let revokedCount = 0;
    if (sessionId) {
      const [count] = await Session.update(
        { revokedAt: now },
        { where: { ...baseWhere, id: sessionId }, transaction: req.transaction || undefined }
      );
      revokedCount = Number(count || 0);
    }

    if (!revokedCount) {
      const [count] = await Session.update(
        { revokedAt: now },
        { where: baseWhere, transaction: req.transaction || undefined }
      );
      revokedCount = Number(count || 0);
    }

    await recordLedgerEvent({
      ts: now,
      playerId: req.user.id,
      sessionId: sessionId || null,
      actionId: sessionId || null,
      eventType: "LOGOUT",
      source: "player.logout",
      meta: buildRequestMeta(req, { revokedCount }),
    });

    return res.json({ ok: true, revoked: revokedCount });
  } catch (err) {
    console.error("[PLAYER_LOGOUT] error:", err);
    return res.status(500).json({ ok: false, error: "Failed to logout player" });
  }
});

// GET /api/v1/player/me (requires player access token)
router.get("/me", requireAuth, async (req, res) => {
  try {
    await touchPlayerSession(req.user.id, req);
    const user = await User.findByPk(req.user.id, {
      include: [{ model: Wallet, as: "wallet" }],
    });
    if (!user || user.role !== "player") {
      return res.status(404).json({ ok: false, error: "Player not found" });
    }
    const bonusState = buildBonusState(user.wallet);
    res.json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        isActive: user.isActive,
        bonusAckRequired: bonusState.ackRequired,
        bonusAppliedMinor: bonusState.appliedMinor,
        bonusPendingMinor: bonusState.pendingMinor,
        bonusBalanceMinor: bonusState.pendingMinor,
      },
      wallet: user.wallet
        ? {
            id: user.wallet.id,
            balance: Number(user.wallet.balance || 0),
            currency: user.wallet.currency,
            bonusPending: Number(user.wallet.bonusPending || 0),
            bonusUnacked: Number(user.wallet.bonusUnacked || 0),
          }
        : null,
      bonus: bonusState,
    });
  } catch (err) {
    console.error("[PLAYER_ME] error:", err);
    res.status(500).json({ ok: false, error: "Failed to load player" });
  }
});

router.post("/bonus/ack", requireAuth, async (req, res) => {
  try {
    const wallet = await Wallet.findOne({ where: { userId: req.user.id } });
    if (!wallet) {
      return res.status(404).json({ ok: false, error: "Wallet not found" });
    }
    wallet.bonusUnacked = 0;
    await wallet.save();
    return res.json({ ok: true, bonus: buildBonusState(wallet) });
  } catch (err) {
    console.error("[PLAYER_BONUS_ACK] error:", err);
    return res.status(500).json({ ok: false, error: "Failed to acknowledge bonus" });
  }
});

module.exports = router;
