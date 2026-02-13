// src/routes/staffRoutes.js
const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();

const { StaffUser } = require('../models');
const { requireStaffAuth, requireStaffRole } = require('../middleware/staffAuth');
const { signAccessToken } = require('../utils/jwt');

// POST /api/v1/staff/login  (username + password)
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' });
    }

    const staff = await StaffUser.findOne({ where: { username } });
    if (!staff || !staff.isActive) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const ok = await bcrypt.compare(password, staff.passwordHash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = signAccessToken({
      id: staff.id,
      role: staff.role,
      tenantId: staff.tenantId || null,
    });

    res.json({
      token,
      staff: {
        id: staff.id,
        username: staff.username,
        role: staff.role,
        agentCode: staff.agentCode,
        parentId: staff.parentId,
      },
    });
  } catch (err) {
    console.error('[STAFF] login error:', err);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// GET /api/v1/staff/me
router.get('/me', requireStaffAuth(), async (req, res) => {
  res.json({ staff: req.staff });
});

// GET /api/v1/staff  (no cashiers)
router.get(
  '/',
  requireStaffRole(['agent', 'operator', 'owner']),
  async (req, res) => {
    try {
      const staffUsers = await StaffUser.findAll({
        order: [['createdAt', 'DESC']],
      });

      res.json(
        staffUsers.map((u) => ({
          id: u.id,
          username: u.username,
          role: u.role,
          agentCode: u.agentCode,
          parentId: u.parentId,
          isActive: u.isActive,
          createdAt: u.createdAt,
        }))
      );
    } catch (err) {
      console.error('[STAFF] list error:', err);
      res.status(500).json({ error: 'Failed to list staff' });
    }
  }
);

// POST /api/v1/staff  (create staff user)
router.post(
  '/',
  requireStaffRole(['operator', 'owner']),
  async (req, res) => {
    try {
      const { username, password, role, agentCode, parentId, isActive } = req.body || {};

      if (!username || !password) {
        return res.status(400).json({ error: 'username and password are required' });
      }

      const normalizedRole = role || 'cashier';
      const allowedRoles = ['cashier', 'agent', 'operator', 'distributor', 'owner'];
      if (!allowedRoles.includes(normalizedRole)) {
        return res.status(400).json({ error: 'Invalid role' });
      }

      if (normalizedRole === 'owner' && req.staff.role !== 'owner') {
        return res.status(403).json({ error: 'Only owner can create owner accounts' });
      }

      const existing = await StaffUser.findOne({ where: { username } });
      if (existing) {
        return res.status(409).json({ error: 'username already taken' });
      }

      const passwordHash = await bcrypt.hash(password, 10);

      const user = await StaffUser.create({
        username,
        passwordHash,
        role: normalizedRole,
        agentCode: agentCode || null,
        parentId: parentId || null,
        isActive: isActive !== undefined ? !!isActive : true,
      });

      res.status(201).json({
        id: user.id,
        username: user.username,
        role: user.role,
        agentCode: user.agentCode,
        parentId: user.parentId,
        isActive: user.isActive,
        createdAt: user.createdAt,
      });
    } catch (err) {
      console.error('[STAFF] create error:', err);
      res.status(500).json({ error: 'Failed to create staff user' });
    }
  }
);

module.exports = router;
