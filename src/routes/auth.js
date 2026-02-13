// src/routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');          // <-- important fix
const User = require('../models/User');
const { RefreshToken } = require("../models");
const { v4: uuidv4 } = require("uuid");
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} = require('../utils/jwt');
const { requireAuth } = require('../middleware/auth');
const { buildRequestMeta, recordLedgerEvent } = require("../services/ledgerService");
const { logEvent } = require("../services/auditService");
const { initTenantContext } = require("../middleware/tenantContext");
const { hashToken } = require("../utils/token");
const { getLock, recordFailure, recordSuccess } = require("../utils/lockout");
const { emitSecurityEvent } = require("../lib/security/events");
const { buildLimiter } = require("../utils/rateLimit");

const loginLimiter = buildLimiter({ windowMs: 15 * 60 * 1000, max: 20, message: "Too many login attempts" });
const adminLoginLimiter = buildLimiter({ windowMs: 15 * 60 * 1000, max: 20, message: "Too many admin login attempts" });

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

async function revokeAllRefreshTokens(userId, reason = "reuse_detected") {
  await RefreshToken.update(
    { revokedAt: new Date(), revokedReason: reason },
    { where: { userId, revokedAt: { [Op.is]: null } } }
  );
}

async function persistRefreshToken({ token, user, req, jti, expiresInDays = 7 }) {
  const hashedToken = hashToken(token);
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  await RefreshToken.create({
    id: jti,
    userId: user.id,
    tenantId: user.tenantId || null,
    role: user.role,
    hashedToken,
    expiresAt,
    ip: req.auditContext?.ip || null,
    userAgent: req.auditContext?.userAgent || null,
  });
}

async function issueTokenPair(user, req) {
  const accessJti = uuidv4();
  const refreshJti = uuidv4();
  const accessToken = signAccessToken(user, { jti: accessJti });
  const refreshToken = signRefreshToken(user, { jti: refreshJti });
  await persistRefreshToken({ token: refreshToken, user, req, jti: refreshJti });
  return { accessToken, refreshToken, refreshJti, accessJti };
}

async function handleLockoutCheck({ subjectType, subjectId, tenantId, res }) {
  const lock = await getLock(subjectType, subjectId, tenantId);
  if (lock.locked) {
    return res.status(429).json({ error: "Account temporarily locked", lockUntil: lock.lockUntil });
  }
  return null;
}

/**
 * POST /auth/register
 */
router.post('/register', async (req, res) => {
  try {
    const { email, username, password, role, tenantId } = req.body;

    if (!email || !username || !password || !tenantId) {
      return res
        .status(400)
        .json({ error: 'email, username, password, and tenantId are required' });
    }

    const lock = await handleLockoutCheck({
      subjectType: "staff_admin",
      subjectId: `${tenantId}:${emailOrUsername.toLowerCase()}`,
      tenantId,
      res,
    });
    if (lock) return;

    return await initTenantContext(
      req,
      res,
      {
        tenantId,
        role: role || "player",
        userId: null,
        allowMissingTenant: false,
      },
      async () => {
        const existingEmail = await User.findOne({ where: { email } });
        if (existingEmail) {
          return res.status(409).json({ error: "Email already in use" });
        }

        const existingUsername = await User.findOne({ where: { username } });
        if (existingUsername) {
          return res.status(409).json({ error: "Username already in use" });
        }

        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);

        const newUser = await User.create({
          email,
          username,
          passwordHash,
          tenantId,
          role: role || "player",
        });

        const tokens = await issueTokenPair(newUser, req);

        return res.status(201).json({
          user: toPublicUser(newUser),
          tokens: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
          },
        });
      }
    );
  } catch (err) {
    console.error('[AUTH] /auth/register error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /auth/login
 * Body: { emailOrUsername, password }
 */
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { emailOrUsername, password, tenantId } = req.body;

    if (!emailOrUsername || !password || !tenantId) {
      return res
        .status(400)
        .json({ error: 'emailOrUsername, password, and tenantId are required' });
    }

    const lockHit = await handleLockoutCheck({
      subjectType: "user",
      subjectId: `${tenantId}:${emailOrUsername.toLowerCase()}`,
      tenantId,
      res,
    });
    if (lockHit) return;

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
        const user = await User.findOne({
          where: {
            [Op.or]: [
              { email: emailOrUsername },
              { username: emailOrUsername },
            ],
          },
        });

        if (!user) {
          const fail = await recordFailure({
            subjectType: "user",
            subjectId: `${tenantId}:${emailOrUsername.toLowerCase()}`,
            tenantId,
            ip: req.auditContext?.ip || null,
            userAgent: req.auditContext?.userAgent || null,
          });
          if (fail.lockUntil) {
            emitSecurityEvent({
              tenantId,
              actorType: "player",
              actorId: null,
              ip: req.auditContext?.ip || null,
              userAgent: req.auditContext?.userAgent || null,
              method: req.method,
              path: req.originalUrl,
              requestId: req.requestId,
              eventType: "lockout_triggered",
              severity: 3,
              details: { username: emailOrUsername, lockUntil: fail.lockUntil },
            });
          }
          emitSecurityEvent({
            tenantId,
            actorType: "player",
            actorId: null,
            ip: req.auditContext?.ip || null,
            userAgent: req.auditContext?.userAgent || null,
            method: req.method,
            path: req.originalUrl,
            requestId: req.requestId,
            eventType: "login_failed",
            severity: 2,
            details: { username: emailOrUsername },
          });
          return res.status(401).json({ error: "Invalid credentials" });
        }

        if (!user.isActive) {
          return res.status(403).json({ error: "Account disabled" });
        }

        const match = await user.checkPassword(password);
        if (!match) {
          const fail = await recordFailure({
            subjectType: "user",
            subjectId: `${tenantId}:${emailOrUsername.toLowerCase()}`,
            tenantId,
            ip: req.auditContext?.ip || null,
            userAgent: req.auditContext?.userAgent || null,
          });
          if (fail.lockUntil) {
            emitSecurityEvent({
              tenantId,
              actorType: "player",
              actorId: user.id,
              ip: req.auditContext?.ip || null,
              userAgent: req.auditContext?.userAgent || null,
              method: req.method,
              path: req.originalUrl,
              requestId: req.requestId,
              eventType: "lockout_triggered",
              severity: 3,
              details: { username: emailOrUsername, lockUntil: fail.lockUntil },
            });
          }
          emitSecurityEvent({
            tenantId,
            actorType: "player",
            actorId: user.id,
            ip: req.auditContext?.ip || null,
            userAgent: req.auditContext?.userAgent || null,
            method: req.method,
            path: req.originalUrl,
            requestId: req.requestId,
            eventType: "login_failed",
            severity: 2,
            details: { username: emailOrUsername },
          });
          return res.status(401).json({ error: "Invalid credentials" });
        }

        await recordSuccess({ subjectType: "user", subjectId: `${tenantId}:${emailOrUsername.toLowerCase()}`, tenantId });

        const tokens = await issueTokenPair(user, req);

        if (user.role === "player") {
          await recordLedgerEvent({
            ts: new Date(),
            playerId: user.id,
            sessionId: null,
            actionId: req.headers["x-session-id"] || null,
            eventType: "LOGIN",
            source: "auth.login",
            meta: buildRequestMeta(req, { source: "password_login" }),
          });
        }

        return res.json({
          user: toPublicUser(user),
          tokens: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
          },
        });
      }
    );
  } catch (err) {
    console.error('[AUTH] /auth/login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /auth/refresh
 */
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'refreshToken is required' });
    }

    const payload = verifyRefreshToken(refreshToken);

    const existing = await RefreshToken.findByPk(payload.jti);
    const hashed = hashToken(refreshToken);

    if (!existing || existing.revokedAt || existing.hashedToken !== hashed) {
      await revokeAllRefreshTokens(payload.sub, "refresh_reuse_detected");
      emitSecurityEvent({
        tenantId: payload.tenantId || null,
        actorType: "user",
        actorId: payload.sub,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        method: req.method,
        path: req.originalUrl,
        requestId: req.requestId,
        eventType: "refresh_reuse_detected",
        severity: 3,
        details: { jti: payload.jti },
      });
      return res.status(401).json({ error: "Refresh token reuse detected" });
    }

    return await initTenantContext(
      req,
      res,
      {
        tenantId: payload.tenantId || null,
        role: payload.role,
        userId: payload.sub,
        allowMissingTenant: false,
      },
      async () => {
        const user = await User.findByPk(payload.sub);
        if (!user || !user.isActive) {
          return res.status(401).json({ error: "Invalid or inactive user" });
        }

        // rotate
        existing.revokedAt = new Date();
        existing.revokedReason = "rotated";
        await existing.save();

        const tokens = await issueTokenPair(user, req);
        await RefreshToken.update(
          { replacedById: tokens.refreshJti },
          { where: { id: existing.id } }
        );

        return res.json({
          user: toPublicUser(user),
          tokens: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
          },
        });
      }
    );
  } catch (err) {
    console.error('[AUTH] /auth/refresh error:', err.message);
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

/**
 * POST /admin/login
 */
router.post('/admin/login', adminLoginLimiter, async (req, res) => {
  try {
    const { emailOrUsername, password, tenantId } = req.body;

    if (!emailOrUsername || !password || !tenantId) {
      await logEvent({
        eventType: "STAFF_LOGIN_FAIL",
        success: false,
        tenantId,
        requestId: req.requestId,
        actorType: "staff",
        actorUsername: emailOrUsername || null,
        route: req.originalUrl,
        method: req.method,
        statusCode: 400,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        meta: { reason: "missing_credentials" },
      });
      return res
        .status(400)
        .json({ error: 'emailOrUsername, password, and tenantId are required' });
    }

    return await initTenantContext(
      req,
      res,
      {
        tenantId,
        role: "admin",
        userId: null,
        allowMissingTenant: false,
      },
      async () => {
        const user = await User.findOne({
          where: {
            [Op.or]: [
              { email: emailOrUsername },
              { username: emailOrUsername },
            ],
          },
        });

        if (!user || user.role !== "admin") {
          const fail = await recordFailure({
            subjectType: "staff_admin",
            subjectId: `${tenantId}:${emailOrUsername.toLowerCase()}`,
            tenantId,
            ip: req.auditContext?.ip,
            userAgent: req.auditContext?.userAgent,
          });
          if (fail.lockUntil) {
            emitSecurityEvent({
              tenantId,
              actorType: "staff",
              actorId: null,
              ip: req.auditContext?.ip || null,
              userAgent: req.auditContext?.userAgent || null,
              method: req.method,
              path: req.originalUrl,
              requestId: req.requestId,
              eventType: "lockout_triggered",
              severity: 3,
              details: { username: emailOrUsername, lockUntil: fail.lockUntil },
            });
          }
          await logEvent({
            eventType: "STAFF_LOGIN_FAIL",
            success: false,
            tenantId,
            requestId: req.requestId,
            actorType: "staff",
            actorUsername: emailOrUsername || null,
            route: req.originalUrl,
            method: req.method,
            statusCode: 401,
            ip: req.auditContext?.ip || null,
            userAgent: req.auditContext?.userAgent || null,
            meta: { reason: "invalid_admin_credentials" },
          });
          return res.status(401).json({ error: "Invalid admin credentials" });
        }

        const match = await user.checkPassword(password);
        if (!match) {
          const fail = await recordFailure({
            subjectType: "staff_admin",
            subjectId: `${tenantId}:${emailOrUsername.toLowerCase()}`,
            tenantId,
            ip: req.auditContext?.ip,
            userAgent: req.auditContext?.userAgent,
          });
          if (fail.lockUntil) {
            emitSecurityEvent({
              tenantId,
              actorType: "staff",
              actorId: null,
              ip: req.auditContext?.ip || null,
              userAgent: req.auditContext?.userAgent || null,
              method: req.method,
              path: req.originalUrl,
              requestId: req.requestId,
              eventType: "lockout_triggered",
              severity: 3,
              details: { username: emailOrUsername, lockUntil: fail.lockUntil },
            });
          }
          await logEvent({
            eventType: "STAFF_LOGIN_FAIL",
            success: false,
            tenantId,
            requestId: req.requestId,
            actorType: "staff",
            actorUsername: emailOrUsername || null,
            route: req.originalUrl,
            method: req.method,
            statusCode: 401,
            ip: req.auditContext?.ip || null,
            userAgent: req.auditContext?.userAgent || null,
            meta: { reason: "invalid_admin_credentials" },
          });
          return res.status(401).json({ error: "Invalid admin credentials" });
        }

        const tokens = await issueTokenPair(user, req);
        await recordSuccess({ subjectType: "staff_admin", subjectId: `${tenantId}:${emailOrUsername.toLowerCase()}`, tenantId });

        await logEvent({
          eventType: "STAFF_LOGIN_SUCCESS",
          success: true,
          tenantId: user.tenantId || tenantId || null,
          requestId: req.requestId,
          actorType: "staff",
          actorId: user.id,
          actorRole: user.role,
          actorUsername: user.username || user.email || null,
          route: req.originalUrl,
          method: req.method,
          statusCode: 200,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          meta: { source: "admin.login" },
          transaction: req.transaction || null,
        });

        return res.json({
          user: toPublicUser(user),
          tokens: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
          },
        });
      }
    );
  } catch (err) {
    console.error('[AUTH] /admin/login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /auth/me
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({ user: toPublicUser(user) });
  } catch (err) {
    console.error('[AUTH] /auth/me error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
