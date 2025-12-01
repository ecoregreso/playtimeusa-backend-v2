// src/routes/staffRoutes.js

const express = require('express');
const router = express.Router();

const { authenticateStaff, createStaffUser } = require('../services/staffAuthService');
const { requireStaffAuth } = require('../middleware/staffAuth');
const { PERMISSIONS, ROLES } = require('../constants/permissions');

// POST /api/v1/staff/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'EMAIL_AND_PASSWORD_REQUIRED' });
    }

    const result = await authenticateStaff({ email, password });

    return res.json({
      ok: true,
      token: result.token,
      staff: result.staff,
    });
  } catch (err) {
    console.error('staff login error', err);
    if (err.code === 'INVALID_CREDENTIALS') {
      return res.status(401).json({ ok: false, error: 'INVALID_CREDENTIALS' });
    }
    if (err.code === 'TENANT_INACTIVE') {
      return res.status(403).json({ ok: false, error: 'TENANT_INACTIVE' });
    }
    return res.status(500).json({ ok: false, error: 'LOGIN_ERROR' });
  }
});

// GET /api/v1/staff/me
router.get('/me', requireStaffAuth(), async (req, res) => {
  return res.json({
    ok: true,
    staff: req.staff,
  });
});

// POST /api/v1/staff/users  (operator / staff-manager only)
router.post(
  '/users',
  requireStaffAuth([PERMISSIONS.STAFF_MANAGE]),
  async (req, res) => {
    try {
      const { role, email, password, displayName, permissions } = req.body || {};
      const allowedRoles = Object.values(ROLES);

      if (!role || !allowedRoles.includes(role)) {
        return res.status(400).json({ ok: false, error: 'INVALID_ROLE' });
      }
      if (!email || !password) {
        return res.status(400).json({ ok: false, error: 'EMAIL_AND_PASSWORD_REQUIRED' });
      }

      const staff = await createStaffUser({
        tenantId: req.staff.tenantId,
        role,
        email,
        password,
        displayName,
        permissions,
      });

      return res.status(201).json({
        ok: true,
        staff: {
          id: staff.id,
          tenantId: staff.tenantId,
          email: staff.email,
          displayName: staff.displayName,
          role: staff.role,
          permissions: staff.permissions,
        },
      });
    } catch (err) {
      console.error('create staff user error', err);
      if (err.name === 'SequelizeUniqueConstraintError') {
        return res.status(400).json({ ok: false, error: 'EMAIL_ALREADY_EXISTS' });
      }
      return res.status(500).json({ ok: false, error: 'CREATE_STAFF_ERROR' });
    }
  }
);

// GET /api/v1/staff/users
router.get(
  '/users',
  requireStaffAuth([PERMISSIONS.STAFF_MANAGE]),
  async (req, res) => {
    try {
      const { StaffUser } = require('../models');

      const staffList = await StaffUser.findAll({
        where: { tenantId: req.staff.tenantId },
        order: [['createdAt', 'DESC']],
        attributes: [
          'id',
          'tenantId',
          'email',
          'displayName',
          'role',
          'permissions',
          'isActive',
          'createdAt',
        ],
      });

      return res.json({
        ok: true,
        staff: staffList,
      });
    } catch (err) {
      console.error('list staff users error', err);
      return res.status(500).json({ ok: false, error: 'LIST_STAFF_ERROR' });
    }
  }
);

module.exports = router;
