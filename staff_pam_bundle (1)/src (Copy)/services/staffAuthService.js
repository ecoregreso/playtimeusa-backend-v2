// src/services/staffAuthService.js

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { StaffUser, Tenant } = require('../models');
const { ROLE_DEFAULT_PERMISSIONS } = require('../constants/permissions');

const JWT_SECRET = process.env.JWT_SECRET || 'development-secret-change-me';
const STAFF_TOKEN_TTL = process.env.STAFF_JWT_TTL || '12h';

function buildPermissions(role, explicit) {
  if (Array.isArray(explicit) && explicit.length > 0) {
    return explicit;
  }
  return ROLE_DEFAULT_PERMISSIONS[role] || [];
}

async function authenticateStaff({ email, password }) {
  const trimmedEmail = String(email || '').trim().toLowerCase();

  const staff = await StaffUser.findOne({
    where: { email: trimmedEmail, isActive: true },
    include: [
      {
        model: Tenant,
        as: 'tenant',
      },
    ],
  });

  if (!staff) {
    const err = new Error('Invalid credentials');
    err.code = 'INVALID_CREDENTIALS';
    throw err;
  }

  if (!staff.tenant || staff.tenant.status === 'suspended') {
    const err = new Error('Tenant inactive or suspended');
    err.code = 'TENANT_INACTIVE';
    throw err;
  }

  const ok = await bcrypt.compare(String(password || ''), staff.passwordHash);
  if (!ok) {
    const err = new Error('Invalid credentials');
    err.code = 'INVALID_CREDENTIALS';
    throw err;
  }

  const perms = buildPermissions(staff.role, staff.permissions);

  const payload = {
    sub: staff.id,
    type: 'staff',
    role: staff.role,
    tenantId: staff.tenantId,
    perms,
  };

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: STAFF_TOKEN_TTL });

  return {
    token,
    staff: {
      id: staff.id,
      tenantId: staff.tenantId,
      email: staff.email,
      displayName: staff.displayName,
      role: staff.role,
      permissions: perms,
    },
  };
}

async function createStaffUser({
  tenantId,
  role,
  email,
  password,
  displayName,
  permissions,
}) {
  const trimmedEmail = String(email || '').trim().toLowerCase();

  const hash = await bcrypt.hash(String(password || ''), 10);

  const staff = await StaffUser.create({
    tenantId,
    role,
    email: trimmedEmail,
    displayName: displayName || trimmedEmail,
    passwordHash: hash,
    permissions: buildPermissions(role, permissions),
  });

  return staff;
}

module.exports = {
  authenticateStaff,
  createStaffUser,
};
