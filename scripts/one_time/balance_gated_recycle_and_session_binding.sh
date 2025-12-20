#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

TS="$(date +%s)"
backup() { [[ -f "$1" ]] && cp "$1" "$1.bak.$TS" && echo "[backup] $1.bak.$TS"; }

backup src/middleware/auth.js
backup src/routes/auth.js
backup src/routes/vouchers.js
backup src/routes/wallets.js

# ---------------------------
# middleware/auth.js
# - requireAuth enforces DB session (sid) on every request
# - requireSessionHeader (optional strict mode) checks X-Session-Id matches JWT sid
# ---------------------------
cat > src/middleware/auth.js <<'JS'
const jwt = require("jsonwebtoken");
const { enforceSessionFromPayload } = require("../services/sessions");

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;

function extractToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  return null;
}

async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: "Missing Authorization header" });

  try {
    const payload = jwt.verify(token, ACCESS_SECRET);

    if (payload.type !== "access") {
      return res.status(401).json({ error: "Invalid token type" });
    }

    // DB-backed session enforcement + idle timeout
    await enforceSessionFromPayload(payload, { touch: true });

    req.user = {
      id: payload.sub,
      role: payload.role,
      actorType: payload.actorType,
      sid: payload.sid,
    };

    return next();
  } catch (err) {
    console.error("[AUTH] Access token error:", err.message || err);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden: insufficient role" });
    return next();
  };
}

/**
 * Optional strict mode:
 *   REQUIRE_SESSION_HEADER=1
 * Client must send:
 *   X-Session-Id: <sid from access token>
 *
 * This prevents “token from one session + request context from another”.
 */
function requireSessionHeader(req, res, next) {
  if (String(process.env.REQUIRE_SESSION_HEADER || "0") !== "1") return next();
  if (!req.user?.sid) return res.status(401).json({ error: "Missing session id" });

  const headerSid =
    req.get("x-session-id") ||
    req.get("x-sessionid") ||
    req.get("x-ptu-session-id") ||
    null;

  if (!headerSid) return res.status(400).json({ error: "Missing X-Session-Id header" });
  if (String(headerSid) !== String(req.user.sid)) return res.status(401).json({ error: "Session header mismatch" });

  return next();
}

module.exports = { requireAuth, requireRole, requireSessionHeader };
JS

# ---------------------------
# routes/auth.js
# - voucher-login supports:
#   (A) first-time voucher activation (redeems voucher, credits wallet, creates user)
#   (B) re-login using same userCode+pin as long as balance > 0 (new session each time)
# - logout only recycles creds when total balance == 0
# ---------------------------
cat > src/routes/auth.js <<'JS'
const express = require("express");
const bcrypt = require("bcryptjs");
const { Op } = require("sequelize");

const { sequelize, User, Voucher, Wallet, Transaction, UserSession } = require("../models");
const { signAccessToken, signRefreshToken, verifyRefreshToken, signAdminToken } = require("../utils/jwt");
const { startSingleSession, enforceSessionFromPayload, revokeSession } = require("../services/sessions");
const { requireAuth, requireSessionHeader } = require("../middleware/auth");

const router = express.Router();

function toPublicUser(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function isEphemeralPlayer(user) {
  const email = String(user?.email || "");
  const username = String(user?.username || "");
  return /^\d{6}$/.test(username) && email.endsWith("@playtimeusa.local");
}

function recycleIdentityTag(userId) {
  const short = String(userId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
  return `recycled_${Date.now()}_${short}`;
}

async function totalBalanceForUser(userId, t) {
  const wallets = await Wallet.findAll({
    where: { userId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  const total = wallets.reduce((sum, w) => sum + Number(w.balance || 0), 0);
  return total;
}

async function recyclePlayerCredentials(user, t) {
  const tag = recycleIdentityTag(user.id);

  user.username = tag;
  user.email = `${tag}@playtimeusa.local`;
  user.passwordHash = await bcrypt.hash(`${tag}:${Math.random()}`, 10);
  user.isActive = false;
  await user.save({ transaction: t });

  // revoke any lingering sessions for this identity
  await UserSession.update(
    { revokedAt: new Date(), updatedAt: new Date() },
    { where: { userId: user.id, revokedAt: null }, transaction: t }
  );
}

async function issueUserTokens(user, req) {
  const session = await startSingleSession({
    actorType: "user",
    userId: user.id,
    role: user.role,
    ip: req.ip,
    userAgent: req.get("user-agent"),
  });

  const accessToken = signAccessToken(user, { actorType: "user", sid: session.id });
  const refreshToken = signRefreshToken(user, { actorType: "user", sid: session.id });

  return { session, tokens: { accessToken, refreshToken } };
}

// POST /auth/login (email/username + password)
router.post("/login", async (req, res) => {
  try {
    const { emailOrUsername, password } = req.body;
    if (!emailOrUsername || !password) return res.status(400).json({ error: "emailOrUsername and password are required" });

    const user = await User.findOne({
      where: { [Op.or]: [{ email: emailOrUsername }, { username: emailOrUsername }] },
    });

    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    if (!user.isActive) return res.status(403).json({ error: "Account disabled" });

    const match = await user.checkPassword(password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    const { session, tokens } = await issueUserTokens(user, req);

    return res.json({ user: toPublicUser(user), tokens, sessionId: session.id });
  } catch (err) {
    console.error("[AUTH] /auth/login error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /auth/voucher-login
 *
 * Behaviors:
 * 1) Re-login (balance > 0): { userCode, pin } (or QR provides userCode+pin) => new session id each login
 * 2) First-time activation: { code, pin } or { userCode, pin } matched to a NEW voucher => redeem + credit + create user
 *
 * IMPORTANT: Voucher credit happens once. Re-logins do NOT re-credit.
 */
router.post("/voucher-login", async (req, res) => {
  const raw = req.body || {};
  const pin = String(raw.pin || "").trim();
  const code = raw.code ? String(raw.code).trim() : null;
  const userCode = raw.userCode ? String(raw.userCode).trim() : null;

  if (!pin) return res.status(400).json({ error: "pin is required" });
  if (!code && !userCode) return res.status(400).json({ error: "userCode or code is required" });

  const isValidUserCode = (uc) => /^\d{6}$/.test(String(uc || ""));

  try {
    // ---------- A) Existing user re-login path ----------
    // Prefer userCode if provided (manual + QR both have it)
    if (userCode && isValidUserCode(userCode)) {
      const existing = await User.findOne({ where: { username: userCode } });
      if (existing) {
        if (!existing.isActive) return res.status(403).json({ error: "Account disabled" });

        const match = await existing.checkPassword(pin);
        if (!match) return res.status(401).json({ error: "Invalid credentials" });

        const balCheck = await sequelize.transaction(async (t) => {
          const locked = await User.findByPk(existing.id, { transaction: t, lock: t.LOCK.UPDATE });
          const total = await totalBalanceForUser(existing.id, t);

          if (locked && isEphemeralPlayer(locked) && total <= 0) {
            await recyclePlayerCredentials(locked, t);
            return { ok: false, status: 401, payload: { error: "Balance is zero; credentials recycled" } };
          }
          return { ok: true, total };
        });

        if (!balCheck.ok) return res.status(balCheck.status).json(balCheck.payload);

        const { session, tokens } = await issueUserTokens(existing, req);

        return res.json({
          ok: true,
          user: toPublicUser(existing),
          tokens,
          sessionId: session.id,
          note: "relogin",
        });
      }
    }

    // If userCode wasn’t sent, allow QR login using code+pin for redeemed voucher:
    if (code) {
      const vAny = await Voucher.findOne({ where: { code, pin } });
      if (vAny?.redeemedByUserId) {
        const u = await User.findByPk(vAny.redeemedByUserId);
        if (u && u.isActive) {
          const match = await u.checkPassword(pin);
          if (match) {
            const balCheck = await sequelize.transaction(async (t) => {
              const locked = await User.findByPk(u.id, { transaction: t, lock: t.LOCK.UPDATE });
              const total = await totalBalanceForUser(u.id, t);
              if (locked && isEphemeralPlayer(locked) && total <= 0) {
                await recyclePlayerCredentials(locked, t);
                return { ok: false, status: 401, payload: { error: "Balance is zero; credentials recycled" } };
              }
              return { ok: true };
            });
            if (!balCheck.ok) return res.status(balCheck.status).json(balCheck.payload);

            const { session, tokens } = await issueUserTokens(u, req);
            return res.json({ ok: true, user: toPublicUser(u), tokens, sessionId: session.id, note: "relogin_via_qr" });
          }
        }
      }
    }

    // ---------- B) First-time voucher activation (single credit) ----------
    const out = await sequelize.transaction(async (t) => {
      let voucher = null;

      if (code) {
        voucher = await Voucher.findOne({
          where: { code, pin, status: "new" },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
      } else {
        // userCode+pin: match voucher metadata userCode
        voucher = await Voucher.findOne({
          where: {
            pin,
            status: "new",
            [Op.and]: sequelize.where(
              sequelize.literal(`metadata->>'userCode'`),
              String(userCode)
            ),
          },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
      }

      if (!voucher) return { ok: false, status: 401, payload: { error: "Invalid credentials or voucher already used" } };
      if (voucher.expiresAt && new Date(voucher.expiresAt) < new Date()) return { ok: false, status: 400, payload: { error: "Voucher expired" } };

      const meta = voucher.metadata || {};
      const loginCode = String(userCode || meta.userCode || "").trim();
      if (!isValidUserCode(loginCode)) return { ok: false, status: 500, payload: { error: "Voucher missing valid userCode" } };

      // Create new ephemeral player identity for this voucher
      const passwordHash = await bcrypt.hash(pin, 10);
      const email = `${loginCode}@playtimeusa.local`;

      // Should not exist because userCode is unique among new vouchers, but be safe:
      const existing = await User.findOne({ where: { username: loginCode }, transaction: t, lock: t.LOCK.UPDATE });
      if (existing) {
        const active = await UserSession.findOne({ where: { userId: existing.id, revokedAt: null }, transaction: t, lock: t.LOCK.UPDATE });
        if (active) return { ok: false, status: 409, payload: { error: "This code is currently in use" } };

        const total = await totalBalanceForUser(existing.id, t);
        // If old account has balance > 0, don’t steal the identity.
        if (total > 0) return { ok: false, status: 409, payload: { error: "This code is reserved (non-zero balance)" } };

        // balance 0: recycle it to free the username
        await recyclePlayerCredentials(existing, t);
      }

      const player = await User.create(
        { email, username: loginCode, passwordHash, role: "player", isActive: true },
        { transaction: t }
      );

      // Wallet credit
      const currency = voucher.currency || "FUN";
      let wallet = await Wallet.findOne({ where: { userId: player.id, currency }, transaction: t, lock: t.LOCK.UPDATE });
      if (!wallet) wallet = await Wallet.create({ userId: player.id, currency, balance: 0 }, { transaction: t });

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
          reference: `voucher:${voucher.code}:activate`,
          metadata: { voucherId: voucher.id, amount, bonus, userCode: loginCode },
          createdByUserId: player.id,
        },
        { transaction: t }
      );

      // Mark voucher redeemed (single credit)
      voucher.status = "redeemed";
      voucher.redeemedAt = new Date();
      voucher.redeemedByUserId = player.id;
      await voucher.save({ transaction: t });

      const voucherSafe = voucher.toJSON ? voucher.toJSON() : voucher;
      if (voucherSafe && typeof voucherSafe === "object") delete voucherSafe.pin;

      return { ok: true, player, wallet, voucher: voucherSafe, tx };
    });

    if (!out.ok) return res.status(out.status).json(out.payload);

    const { session, tokens } = await issueUserTokens(out.player, req);

    // stamp sessionId into the voucher_credit tx metadata for audit
    try {
      const txRow = await Transaction.findByPk(out.tx.id);
      const md = txRow?.metadata || {};
      txRow.metadata = { ...md, sessionId: session.id };
      await txRow.save();
    } catch {}

    return res.json({
      ok: true,
      user: toPublicUser(out.player),
      tokens,
      sessionId: session.id,
      wallet: out.wallet,
      voucher: out.voucher,
      note: "activated",
    });
  } catch (err) {
    console.error("[AUTH] /auth/voucher-login error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/refresh
router.post("/refresh", async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: "refreshToken is required" });

    const payload = verifyRefreshToken(refreshToken);
    if (payload.type !== "refresh") return res.status(401).json({ error: "Invalid token type" });
    if (payload.actorType !== "user") return res.status(403).json({ error: "Not a user refresh token" });

    await enforceSessionFromPayload(payload, { touch: false });

    const user = await User.findByPk(payload.sub);
    if (!user || !user.isActive) return res.status(401).json({ error: "Invalid or inactive user" });

    const newAccessToken = signAccessToken(user, { actorType: "user", sid: payload.sid });
    const newRefreshToken = signRefreshToken(user, { actorType: "user", sid: payload.sid });

    return res.json({ user: toPublicUser(user), tokens: { accessToken: newAccessToken, refreshToken: newRefreshToken } });
  } catch (err) {
    console.error("[AUTH] /auth/refresh error:", err.message || err);
    return res.status(401).json({ error: "Invalid or expired refresh token" });
  }
});

// POST /auth/logout
// - always revokes session
// - ONLY recycles (disables + frees username) if total balance == 0
router.post("/logout", requireAuth, requireSessionHeader, async (req, res) => {
  try {
    await revokeSession(req.user.sid);

    if (req.user.actorType === "user" && req.user.role === "player") {
      await sequelize.transaction(async (t) => {
        const u = await User.findByPk(req.user.id, { transaction: t, lock: t.LOCK.UPDATE });
        if (!u || !isEphemeralPlayer(u)) return;

        const total = await totalBalanceForUser(u.id, t);
        if (total <= 0) {
          await recyclePlayerCredentials(u, t);
        }
      });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("[AUTH] /auth/logout error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /admin/login
router.post("/admin/login", async (req, res) => {
  try {
    const { emailOrUsername, password } = req.body;
    if (!emailOrUsername || !password) return res.status(400).json({ error: "emailOrUsername and password are required" });

    const user = await User.findOne({
      where: { [Op.or]: [{ email: emailOrUsername }, { username: emailOrUsername }] },
    });

    if (!user || user.role !== "admin") return res.status(401).json({ error: "Invalid admin credentials" });

    const match = await user.checkPassword(password);
    if (!match) return res.status(401).json({ error: "Invalid admin credentials" });

    const { session, tokens } = await issueUserTokens(user, req);
    const adminToken = signAdminToken(user);

    return res.json({ user: toPublicUser(user), tokens: { adminToken, ...tokens }, sessionId: session.id });
  } catch (err) {
    console.error("[AUTH] /admin/login error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /auth/me
router.get("/me", requireAuth, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json({ user: toPublicUser(user) });
  } catch (err) {
    console.error("[AUTH] /auth/me error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
JS

# ---------------------------
# routes/vouchers.js
# - stamp sessionId into transaction metadata for audit
# - optional requireSessionHeader on mutation routes
# ---------------------------
cat > src/routes/vouchers.js <<'JS'
const express = require("express");
const { Op } = require("sequelize");
const { requireAuth, requireRole, requireSessionHeader } = require("../middleware/auth");
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
  requireSessionHeader,
  async (req, res) => {
    try {
      const { amount, bonusAmount, currency } = req.body || {};

      const valueAmount = Number(amount || 0);
      const valueBonus = Number(bonusAmount || 0);

      if (!Number.isFinite(valueAmount) || valueAmount <= 0) return res.status(400).json({ error: "Invalid amount" });
      if (!Number.isFinite(valueBonus) || valueBonus < 0) return res.status(400).json({ error: "Invalid bonusAmount" });

      const finalCurrency = (currency || "FUN").toUpperCase();

      // DB enforces uniqueness for status='new' userCodes via partial unique index.
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
            metadata: { userCode, source: "admin_panel", createdSessionId: req.user.sid },
            ...creatorFields(req),
          });
          break;
        } catch (e) {
          if (String(e?.parent?.code) === "23505") continue; // unique_violation
          throw e;
        }
      }

      if (!voucher) return res.status(500).json({ error: "Failed to create voucher (unique collision loop)" });

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
  requireSessionHeader,
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
        if (voucher.expiresAt && new Date(voucher.expiresAt) < new Date()) return { ok: false, status: 400, payload: { error: "Voucher expired" } };

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
            metadata: { voucherId: voucher.id, amount, bonus, sessionId: req.user.sid },
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

# ---------------------------
# routes/wallets.js
# - include owner/operator in staff roles
# - stamp sessionId into tx metadata
# - optional requireSessionHeader on mutation routes
# ---------------------------
cat > src/routes/wallets.js <<'JS'
const express = require("express");
const { sequelize } = require("../models");
const { User, Wallet, Transaction } = require("../models");
const { requireAuth, requireRole, requireSessionHeader } = require("../middleware/auth");

const router = express.Router();

async function getOrCreateWallet(userId, currency, t) {
  const cur = (currency || "FUN").toUpperCase();
  let wallet = await Wallet.findOne({ where: { userId, currency: cur }, transaction: t, lock: t.LOCK.UPDATE });
  if (!wallet) wallet = await Wallet.create({ userId, currency: cur, balance: 0 }, { transaction: t });
  return wallet;
}

// GET /api/v1/wallets  (current authenticated player's wallets)
router.get("/", requireAuth, requireRole("player"), async (req, res) => {
  try {
    const wallets = await Wallet.findAll({ where: { userId: req.user.id } });
    return res.json({ ok: true, wallets });
  } catch (err) {
    console.error("[WALLETS] list self error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/v1/wallets/:userId  (staff view)
router.get(
  "/:userId",
  requireAuth,
  requireRole("owner", "operator", "admin", "agent", "cashier"),
  async (req, res) => {
    try {
      const { userId } = req.params;

      const wallets = await Wallet.findAll({ where: { userId } });
      if (!wallets || wallets.length === 0) return res.status(404).json({ error: "Wallet not found" });

      const walletIds = wallets.map((w) => w.id);

      const transactions = await Transaction.findAll({
        where: { walletId: walletIds },
        order: [["createdAt", "DESC"]],
        limit: 50,
      });

      return res.json({ wallets, transactions });
    } catch (err) {
      console.error("[WALLETS] GET /wallets/:userId error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /api/v1/wallets/:userId/credit  (staff)
router.post(
  "/:userId/credit",
  requireAuth,
  requireRole("owner", "operator", "admin", "agent", "cashier"),
  requireSessionHeader,
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const { userId } = req.params;
      const { amount, currency = "FUN", type = "manual_credit", reference, metadata } = req.body || {};

      const numericAmount = Number(amount);
      if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        await t.rollback();
        return res.status(400).json({ error: "amount must be > 0" });
      }

      const user = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!user) {
        await t.rollback();
        return res.status(404).json({ error: "User not found" });
      }

      const wallet = await getOrCreateWallet(userId, currency, t);

      const balanceBefore = Number(wallet.balance || 0);
      const balanceAfter = balanceBefore + numericAmount;

      wallet.balance = balanceAfter;
      await wallet.save({ transaction: t });

      const tx = await Transaction.create(
        {
          walletId: wallet.id,
          type,
          amount: numericAmount,
          balanceBefore,
          balanceAfter,
          reference: reference || null,
          metadata: { ...(metadata || {}), sessionId: req.user.sid },
          createdByUserId: req.user.id,
        },
        { transaction: t }
      );

      await t.commit();
      return res.status(201).json({ wallet, transaction: tx });
    } catch (err) {
      console.error("[WALLETS] POST /wallets/:userId/credit error:", err);
      await t.rollback();
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /api/v1/wallets/:userId/debit  (staff)
router.post(
  "/:userId/debit",
  requireAuth,
  requireRole("owner", "operator", "admin", "agent", "cashier"),
  requireSessionHeader,
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const { userId } = req.params;
      const { amount, currency = "FUN", type = "manual_debit", reference, metadata } = req.body || {};

      const numericAmount = Number(amount);
      if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        await t.rollback();
        return res.status(400).json({ error: "amount must be > 0" });
      }

      const user = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!user) {
        await t.rollback();
        return res.status(404).json({ error: "User not found" });
      }

      const wallet = await getOrCreateWallet(userId, currency, t);

      const balanceBefore = Number(wallet.balance || 0);
      if (balanceBefore < numericAmount) {
        await t.rollback();
        return res.status(400).json({ error: "Insufficient funds" });
      }

      const balanceAfter = balanceBefore - numericAmount;

      wallet.balance = balanceAfter;
      await wallet.save({ transaction: t });

      const tx = await Transaction.create(
        {
          walletId: wallet.id,
          type,
          amount: numericAmount,
          balanceBefore,
          balanceAfter,
          reference: reference || null,
          metadata: { ...(metadata || {}), sessionId: req.user.sid },
          createdByUserId: req.user.id,
        },
        { transaction: t }
      );

      await t.commit();
      return res.status(201).json({ wallet, transaction: tx });
    } catch (err) {
      console.error("[WALLETS] POST /wallets/:userId/debit error:", err);
      await t.rollback();
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

module.exports = router;
JS

# ---------------------------
# Smoke test: relogin allowed while balance > 0; recycle triggers when balance == 0
# ---------------------------
mkdir -p scripts/smoke
cat > scripts/smoke/voucher_relogin_balance_gate.sh <<'BASH2'
#!/usr/bin/env bash
set -euo pipefail

API="${API_BASE_URL:-http://localhost:3000}"
STAFF_USER="${STAFF_USER:?Set STAFF_USER}"
STAFF_PASS="${STAFF_PASS:?Set STAFF_PASS}"

node - <<'NODE'
const API = process.env.API_BASE_URL || "http://localhost:3000";
const STAFF_USER = process.env.STAFF_USER;
const STAFF_PASS = process.env.STAFF_PASS;

function jwtSid(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload.sid || null;
  } catch {
    return null;
  }
}

async function req(method, path, { token, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
    const sid = jwtSid(token);
    if (sid) headers["x-session-id"] = sid;
  }
  const res = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  let json = null;
  if (ct.includes("application/json")) {
    try { json = JSON.parse(text); } catch {}
  }
  return { res, text, json };
}

(async () => {
  // Staff login
  const login = await req("POST", "/api/v1/staff/login", {
    body: { username: STAFF_USER, password: STAFF_PASS },
  });
  if (!login.res.ok) throw new Error(`staff login failed ${login.res.status} ${login.text}`);

  const staffToken = login.json?.tokens?.accessToken || login.json?.token;
  if (!staffToken) throw new Error("staff token missing");

  // Create voucher
  const create = await req("POST", "/api/v1/vouchers", {
    token: staffToken,
    body: { amount: 100, bonusAmount: 50, currency: "FUN" },
  });
  if (!create.res.ok) throw new Error(`create voucher failed ${create.res.status} ${create.text}`);

  const v = create.json?.voucher;
  const pin = create.json?.pin;
  const userCode = create.json?.userCode;
  if (!v?.code || !pin || !userCode) throw new Error("voucher create missing fields");

  // First login (activates voucher)
  const p1 = await req("POST", "/api/v1/auth/voucher-login", {
    body: { userCode, pin, code: v.code },
  });
  if (!p1.res.ok) throw new Error(`player login1 failed ${p1.res.status} ${p1.text}`);

  const pToken1 = p1.json?.tokens?.accessToken;
  const session1 = p1.json?.sessionId;
  const playerId = p1.json?.user?.id;
  if (!pToken1 || !session1 || !playerId) throw new Error("player login1 missing token/session/user");

  const w1 = await req("GET", "/api/v1/wallets", { token: pToken1 });
  if (!w1.res.ok) throw new Error(`wallets after login1 failed ${w1.res.status} ${w1.text}`);
  const fun1 = (w1.json?.wallets || []).find(x => (x.currency || "FUN") === "FUN") || (w1.json?.wallets || [])[0];
  const bal1 = Number(fun1?.balance || 0);
  if (bal1 <= 0) throw new Error("expected positive balance after activation");

  // Logout (balance > 0 => SHOULD NOT recycle)
  const lo1 = await req("POST", "/api/v1/auth/logout", { token: pToken1 });
  if (!lo1.res.ok) throw new Error(`logout1 failed ${lo1.res.status} ${lo1.text}`);

  // Relogin (should succeed and sessionId must change)
  const p2 = await req("POST", "/api/v1/auth/voucher-login", {
    body: { userCode, pin }, // relogin path
  });
  if (!p2.res.ok) throw new Error(`player login2 failed ${p2.res.status} ${p2.text}`);

  const pToken2 = p2.json?.tokens?.accessToken;
  const session2 = p2.json?.sessionId;
  if (!pToken2 || !session2) throw new Error("player login2 missing token/session");
  if (String(session2) === String(session1)) throw new Error("expected new sessionId on relogin");

  const w2 = await req("GET", "/api/v1/wallets", { token: pToken2 });
  if (!w2.res.ok) throw new Error(`wallets after login2 failed ${w2.res.status} ${w2.text}`);
  const fun2 = (w2.json?.wallets || []).find(x => (x.currency || "FUN") === "FUN") || (w2.json?.wallets || [])[0];
  const bal2 = Number(fun2?.balance || 0);
  if (bal2 !== bal1) throw new Error(`balance changed on relogin (should not). before=${bal1} after=${bal2}`);

  // Staff debits wallet to zero (simulate game losses)
  const debit = await req("POST", `/api/v1/wallets/${playerId}/debit`, {
    token: staffToken,
    body: { amount: bal2, currency: "FUN", type: "test_debit_to_zero", reference: "smoke:zero" },
  });
  if (!debit.res.ok) throw new Error(`staff debit failed ${debit.res.status} ${debit.text}`);

  // Player logout now should recycle (balance == 0)
  const lo2 = await req("POST", "/api/v1/auth/logout", { token: pToken2 });
  if (!lo2.res.ok) throw new Error(`logout2 failed ${lo2.res.status} ${lo2.text}`);

  // Relogin should FAIL now
  const p3 = await req("POST", "/api/v1/auth/voucher-login", {
    body: { userCode, pin },
  });
  if (p3.res.ok) throw new Error("expected relogin to fail after balance==0 recycle");

  console.log("PASS: relogin works while balance>0; recycle triggers only at balance==0; sessionId rotates on relogin");
  console.log("Created:", { voucherCode: v.code, userCode, pin, balanceActivated: bal1 });
})().catch((e) => {
  console.error("FAIL:", e?.message || e);
  process.exit(1);
});
NODE
BASH2

chmod +x scripts/smoke/voucher_relogin_balance_gate.sh

echo "[ok] Applied: balance-gated recycle + relogin + optional session header gate + relogin smoke test"
echo "    Run: API_BASE_URL=http://localhost:3000 STAFF_USER=owner STAFF_PASS='Owner123!' ./scripts/smoke/voucher_relogin_balance_gate.sh"
echo "    Strict mode (optional): set REQUIRE_SESSION_HEADER=1 in .env and restart backend"
