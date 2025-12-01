// src/routes/adminAuth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();

const { AdminUser } = require('../models');

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_BOOTSTRAP_SECRET = process.env.ADMIN_BOOTSTRAP_SECRET || 'dev-bootstrap';

// POST /api/auth/admin/bootstrap
// Create initial ADMIN user (protected by ADMIN_BOOTSTRAP_SECRET)
router.post('/bootstrap', async (req, res) => {
  try {
    const { secret, email, password } = req.body;

    if (secret !== ADMIN_BOOTSTRAP_SECRET) {
      return res.status(403).json({ error: 'invalid_bootstrap_secret' });
    }

    if (!email || !password) {
      return res
        .status(400)
        .json({ error: 'email and password are required' });
    }

    const existing = await AdminUser.findOne({ where: { email } });
    if (existing) {
      return res.status(400).json({ error: 'admin_already_exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const admin = await AdminUser.create({
      email,
      passwordHash,
      role: 'ADMIN',
    });

    return res.status(201).json({
      id: admin.id,
      email: admin.email,
      role: admin.role,
    });
  } catch (err) {
    console.error('[ADMIN BOOTSTRAP] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/auth/admin/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ error: 'email and password are required' });
    }

    const admin = await AdminUser.findOne({ where: { email } });

    if (!admin || !admin.isActive) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const valid = await bcrypt.compare(password, admin.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    const token = jwt.sign(
      {
        sub: admin.id,
        role: admin.role,
      },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    return res.status(200).json({
      token,
      admin: {
        id: admin.id,
        email: admin.email,
        role: admin.role,
      },
    });
  } catch (err) {
    console.error('[ADMIN LOGIN] error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;

