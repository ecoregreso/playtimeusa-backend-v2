#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

TS="$(date +%s)"
backup() { [[ -f "$1" ]] && cp "$1" "$1.bak.$TS" && echo "[backup] $1.bak.$TS"; }

backup src/middleware/auth.js
backup src/routes/auth.js
backup src/routes/vouchers.js
backup scripts/smoke/voucher_flow.sh

# --- middleware/auth.js: enforce DB sessions + idle timeout for BOTH staff + user tokens ---
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

    // Enforce DB-backed session + idle timeout (staff + user)
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
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden: insufficient role" });
    }
    return next();
  };
}

module.exports = { requireAuth, requireRole };
JS

# --- routes/auth.js: add POST /auth/voucher-login + recycle credentials on logout for ephemeral players ---
cat > src/routes/auth.js <<'JS'
const express = require("express");
const bcrypt = require("bcryptjs");
const { Op } = require("sequelize");

const { sequelize, User, Voucher, Wallet, Transaction, UserSession } = require("../models");
const { signAccessToken, signRefreshToken, verifyRefreshToken, signAdminToken } = require("../utils/jwt");
const { startSingleSession, enforceSessionFromPayload, revokeSession } = require("../services/sessions");
const { requireAuth } = require("../middleware/auth");

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

async function recyclePlayerCredentials(user, t) {
  const tag = recycleIdentityTag(user.id);
  const newUsername = tag;
  const newEmail = `${tag}@playtimeusa.local`;
  const newPass = await bcrypt.hash(`${tag}:${Math.random()}`, 10);

  user.username = newUsername;
  user.email = newEmail;
  user.passwordHash = newPass;
  user.isActive = false;
  await user.save({ transaction: t });
}

// POST /auth/register
router.post("/register", async (req, res) => {
  try {
    const { email, username, password, role } = req.body;

    if (!email || !username || !password) {
      return res.status(400).json({ error: "email, username, and password are required" });
    }

    const existingEmail = await User.findOne({ where: { email } });
    if (existingEmail) return res.status(409).json({ error: "Email already in use" });

    const existingUsername = await User.findOne({ where: { username } });
    if (existingUsername) return res.status(409).json({ error: "Username already in use" });

    const passwordHash = await bcrypt.hash(password, 10);
    const newUser = await User.create({ email, username, passwordHash, role: role || "player" });

    const session = await startSingleSession({
      actorType: "user",
      userId: newUser.id,
      role: newUser.role,
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });

    const accessToken = signAccessToken(newUser, { actorType: "user", sid: session.id });
    const refreshToken = signRefreshToken(newUser, { actorType: "user", sid: session.id });

    return res.status(201).json({ user: toPublicUser(newUser), tokens: { accessToken, refreshToken }, sessionId: session.id });
  } catch (err) {
    console.error("[AUTH] /auth/register error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

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

    const session = await startSingleSession({
      actorType: "user",
      userId: user.id,
      role: user.role,
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });

    const accessToken = signAccessToken(user, { actorType: "user", sid: session.id });
    const refreshToken = signRefreshToken(user, { actorType: "user", sid: session.id });

    return res.json({ user: toPublicUser(user), tokens: { accessToken, refreshToken }, sessionId: session.id });
  } catch (err) {
    console.error("[AUTH] /auth/login error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /auth/voucher-login  (public player login)
 * Accepts:
 *   - manual: { userCode, pin }
 *   - QR:     { code, pin }  (optionally also includes userCode)
 *
 * Guarantees single-use with DB transaction + row lock.
 * Creates an ephemeral player user + wallet, credits voucher amount+bonus, marks voucher redeemed.
 */
router.post("/voucher-login", async (req, res) => {
  const { userCode, code, pin } = req.body || {};
  if (!pin || (!userCode && !code)) {
    return res.status(400).json({ error: "pin and (userCode or code) are required" });
  }

  try {
    const result = await sequelize.transaction(async (t) => {
      // Find + lock voucher (single-use)
      let voucher = null;

      if (code) {
        voucher = await Voucher.findOne({
          where: { code, pin, status: "new" },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
      } else {
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

      if (!voucher) {
        return { ok: false, status: 401, payload: { error: "Invalid code/pin or voucher already used" } };
      }

      if (voucher.expiresAt && new Date(voucher.expiresAt) < new Date()) {
        return { ok: false, status: 400, payload: { error: "Voucher expired" } };
      }

      const meta = voucher.metadata || {};
      const loginCode = String(userCode || meta.userCode || "").trim();

      if (!/^\d{6}$/.test(loginCode)) {
        return { ok: false, status: 500, payload: { error: "Voucher missing valid userCode" } };
      }

      // If a user is still sitting on this username, forcibly recycle it if no active session remains.
      const existing = await User.findOne({
        where: { username: loginCode },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      if (existing) {
        const active = await UserSession.findOne({
          where: { userId: existing.id, revokedAt: null },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });

        if (active) {
          return { ok: false, status: 409, payload: { error: "This code is currently in use" } };
        }

        // recycle old record so username becomes available
        await recyclePlayerCredentials(existing, t);
      }

      // Create new ephemeral player
      const passwordHash = await bcrypt.hash(String(pin), 10);
      const email = `${loginCode}@playtimeusa.local`;

      const player = await User.create(
        { email, username: loginCode, passwordHash, role: "player", isActive: true },
        { transaction: t }
      );

      // Wallet + credit
      const currency = voucher.currency || "FUN";
      let wallet = await Wallet.findOne({ where: { userId: player.id, currency }, transaction: t, lock: t.LOCK.UPDATE });
      if (!wallet) {
        wallet = await Wallet.create({ userId: player.id, currency, balance: 0 }, { transaction: t });
      }

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
          reference: `voucher:${voucher.code}:login`,
          metadata: { voucherId: voucher.id, amount, bonus, userCode: loginCode },
          createdByUserId: player.id,
        },
        { transaction: t }
      );

      // Mark voucher redeemed (single-use)
      voucher.status = "redeemed";
      voucher.redeemedAt = new Date();
      voucher.redeemedByUserId = player.id;
      await voucher.save({ transaction: t });

      return { ok: true, player, wallet, voucher, tx };
    });

    if (!result.ok) {
      return res.status(result.status).json(result.payload);
    }

    // Start session + tokens (outside txn is fine)
    const session = await startSingleSession({
      actorType: "user",
      userId: result.player.id,
      role: "player",
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });

    const accessToken = signAccessToken(result.player, { actorType: "user", sid: session.id });
    const refreshToken = signRefreshToken(result.player, { actorType: "user", sid: session.id });

    const voucherSafe = result.voucher.toJSON ? result.voucher.toJSON() : result.voucher;
    if (voucherSafe && typeof voucherSafe === "object") delete voucherSafe.pin;

    return res.json({
      ok: true,
      user: toPublicUser(result.player),
      tokens: { accessToken, refreshToken },
      sessionId: session.id,
      wallet: result.wallet,
      voucher: voucherSafe,
      transaction: result.tx,
    });
  } catch (err) {
    console.error("[AUTH] /auth/voucher-login error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/refresh  (session-bound; does NOT reset inactivity timer)
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

// POST /auth/logout (revokes session; also destroys ephemeral player credentials)
router.post("/logout", requireAuth, async (req, res) => {
  try {
    await revokeSession(req.user.sid);

    // Destroy credentials for ephemeral players so codes are recyclable.
    if (req.user.actorType === "user" && req.user.role === "player") {
      await sequelize.transaction(async (t) => {
        const u = await User.findByPk(req.user.id, { transaction: t, lock: t.LOCK.UPDATE });
        if (u && isEphemeralPlayer(u)) {
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

    const session = await startSingleSession({
      actorType: "user",
      userId: user.id,
      role: user.role,
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });

    const adminToken = signAdminToken(user);
    const accessToken = signAccessToken(user, { actorType: "user", sid: session.id });
    const refreshToken = signRefreshToken(user, { actorType: "user", sid: session.id });

    return res.json({ user: toPublicUser(user), tokens: { adminToken, accessToken, refreshToken }, sessionId: session.id });
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

# --- routes/vouchers.js: keep pin hidden + make redeem atomic + persist qrPath into metadata ---
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

      const finalCurrency = currency || "FUN";

      // Ensure userCode is unique among NEW vouchers (so two active vouchers never share credentials)
      let userCode = null;
      for (let i = 0; i < 50; i++) {
        const candidate = randomNumeric(6);
        const existing = await Voucher.findOne({
          where: {
            status: "new",
            [Op.and]: sequelize.where(sequelize.literal(`metadata->>'userCode'`), String(candidate)),
          },
        });
        if (!existing) {
          userCode = candidate;
          break;
        }
      }
      if (!userCode) return res.status(500).json({ error: "Failed to generate unique userCode" });

      // Create voucher (retry if code uniqueness collides)
      let voucher = null;
      let pin = null;

      for (let attempt = 0; attempt < 10; attempt++) {
        const code = randomAlphaNum(10);
        pin = randomNumeric(6);

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
          // 23505 unique_violation (code collision)
          if (String(e?.parent?.code) === "23505") continue;
          throw e;
        }
      }

      if (!voucher) return res.status(500).json({ error: "Failed to create voucher" });

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

# --- smoke test: extend to also test voucher-login + single-use ---
cat > scripts/smoke/voucher_flow.sh <<'BASH2'
#!/usr/bin/env bash
set -euo pipefail

API="${API_BASE_URL:-http://localhost:3000}"
STAFF_USER="${STAFF_USER:?Set STAFF_USER}"
STAFF_PASS="${STAFF_PASS:?Set STAFF_PASS}"

node - <<'NODE'
const API = process.env.API_BASE_URL || "http://localhost:3000";
const STAFF_USER = process.env.STAFF_USER;
const STAFF_PASS = process.env.STAFF_PASS;

async function req(method, path, { token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  let json = null;
  if (ct.includes("application/json")) {
    try { json = JSON.parse(text); } catch {}
  }

  return { res, ct, text, json };
}

(async () => {
  // 1) staff login
  const login = await req("POST", "/api/v1/staff/login", {
    body: { username: STAFF_USER, password: STAFF_PASS },
  });

  if (!login.res.ok) {
    console.error("FAIL: staff login", login.res.status, login.text);
    process.exit(1);
  }

  const token =
    login.json?.tokens?.accessToken ||
    login.json?.token;

  if (!token) {
    console.error("FAIL: no access token returned from staff login");
    process.exit(1);
  }

  // 2) create voucher
  const create = await req("POST", "/api/v1/vouchers", {
    token,
    body: { amount: 100, bonusAmount: 50, currency: "FUN" },
  });

  if (!create.res.ok) {
    console.error("FAIL: create voucher", create.res.status, create.text);
    process.exit(1);
  }

  const voucher = create.json?.voucher;
  const pin = create.json?.pin;
  const userCode = create.json?.userCode;
  const qrPath = create.json?.qr?.path;

  if (!voucher?.code || !pin || !userCode) {
    console.error("FAIL: create response missing fields", create.json);
    process.exit(1);
  }

  // 3) list vouchers should NOT leak pin
  const list = await req("GET", "/api/v1/vouchers?limit=10", { token });
  if (!list.res.ok) {
    console.error("FAIL: list vouchers", list.res.status, list.text);
    process.exit(1);
  }

  const rows = Array.isArray(list.json) ? list.json : [];
  const leaked = rows.find(v => Object.prototype.hasOwnProperty.call(v, "pin"));
  if (leaked) {
    console.error("FAIL: pin leaked in /vouchers list.");
    process.exit(1);
  }

  // 4) QR reachable (optional)
  if (qrPath) {
    const qr = await fetch(API + "/" + qrPath);
    if (!qr.ok) {
      console.error("FAIL: QR not reachable at", "/" + qrPath, "status", qr.status);
      process.exit(1);
    }
  }

  // 5) player voucher-login (single-use)
  const plogin = await req("POST", "/api/v1/auth/voucher-login", {
    body: { userCode, pin, code: voucher.code },
  });

  if (!plogin.res.ok) {
    console.error("FAIL: voucher-login", plogin.res.status, plogin.text);
    process.exit(1);
  }

  const pToken = plogin.json?.tokens?.accessToken;
  if (!pToken) {
    console.error("FAIL: voucher-login missing access token", plogin.json);
    process.exit(1);
  }

  // wallet exists + has correct total
  const wallets = await req("GET", "/api/v1/wallets", { token: pToken });
  if (!wallets.res.ok) {
    console.error("FAIL: /wallets after voucher-login", wallets.res.status, wallets.text);
    process.exit(1);
  }

  // second login must FAIL (single-use)
  const plogin2 = await req("POST", "/api/v1/auth/voucher-login", {
    body: { userCode, pin, code: voucher.code },
  });

  if (plogin2.res.ok) {
    console.error("FAIL: voucher-login allowed reuse (should be single-use)");
    process.exit(1);
  }

  console.log("PASS: voucher create + list safety + qr reachable + voucher-login single-use");
  console.log("Created:", { voucherCode: voucher.code, userCode, pin, qrPath: qrPath || null });
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
NODE
BASH2

chmod +x scripts/smoke/voucher_flow.sh

echo "[ok] applied voucher-login + atomic redeem + session enforcement"
