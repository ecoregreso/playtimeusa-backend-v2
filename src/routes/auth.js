// src/routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');          // <-- important fix
const User = require('../models/User');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  signAdminToken,
} = require('../utils/jwt');
const { requireAuth } = require('../middleware/auth');
const { buildRequestMeta, recordLedgerEvent } = require("../services/ledgerService");

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

/**
 * POST /auth/register
 */
router.post('/register', async (req, res) => {
  try {
    const { email, username, password, role } = req.body;

    if (!email || !username || !password) {
      return res.status(400).json({ error: 'email, username, and password are required' });
    }

    const existingEmail = await User.findOne({ where: { email } });
    if (existingEmail) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    const existingUsername = await User.findOne({ where: { username } });
    if (existingUsername) {
      return res.status(409).json({ error: 'Username already in use' });
    }

    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const newUser = await User.create({
      email,
      username,
      passwordHash,
      role: role || 'player',
    });

    const accessToken = signAccessToken(newUser);
    const refreshToken = signRefreshToken(newUser);

    return res.status(201).json({
      user: toPublicUser(newUser),
      tokens: {
        accessToken,
        refreshToken,
      },
    });
  } catch (err) {
    console.error('[AUTH] /auth/register error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /auth/login
 * Body: { emailOrUsername, password }
 */
router.post('/login', async (req, res) => {
  try {
    const { emailOrUsername, password } = req.body;

    if (!emailOrUsername || !password) {
      return res.status(400).json({ error: 'emailOrUsername and password are required' });
    }

    const user = await User.findOne({
      where: {
        [Op.or]: [
          { email: emailOrUsername },
          { username: emailOrUsername },
        ],
      },
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: 'Account disabled' });
    }

    const match = await user.checkPassword(password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);

    if (user.role === "player") {
      await recordLedgerEvent({
        ts: new Date(),
        playerId: user.id,
        sessionId: null,
        eventType: "LOGIN",
        meta: buildRequestMeta(req, { source: "password_login" }),
      });
    }

    return res.json({
      user: toPublicUser(user),
      tokens: {
        accessToken,
        refreshToken,
      },
    });
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

    const user = await User.findByPk(payload.sub);
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Invalid or inactive user' });
    }

    const newAccessToken = signAccessToken(user);
    const newRefreshToken = signRefreshToken(user);

    return res.json({
      user: toPublicUser(user),
      tokens: {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      },
    });
  } catch (err) {
    console.error('[AUTH] /auth/refresh error:', err.message);
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

/**
 * POST /admin/login
 */
router.post('/admin/login', async (req, res) => {
  try {
    const { emailOrUsername, password } = req.body;

    if (!emailOrUsername || !password) {
      return res.status(400).json({ error: 'emailOrUsername and password are required' });
    }

    const user = await User.findOne({
      where: {
        [Op.or]: [
          { email: emailOrUsername },
          { username: emailOrUsername },
        ],
      },
    });

    if (!user || user.role !== 'admin') {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }

    const match = await user.checkPassword(password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }

    const adminToken = signAdminToken(user);
    const accessToken = signAccessToken(user);

    return res.json({
      user: toPublicUser(user),
      tokens: {
        adminToken,
        accessToken,
      },
    });
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
