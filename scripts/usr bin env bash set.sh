#!/usr/bin/env bash
set -euo pipefail

echo ">>> PlaytimeUSA PAM++ staff bundle installer"

ROOT_DIR="$(pwd)"
SRC_DIR="$ROOT_DIR/src"

# Basic sanity check
if [ ! -d "$SRC_DIR" ]; then
  echo "ERROR: src/ not found here. Run this from your backend-v2 root."
  exit 1
fi

mkdir -p \
  "$SRC_DIR/constants" \
  "$SRC_DIR/models" \
  "$SRC_DIR/services" \
  "$SRC_DIR/middleware" \
  "$SRC_DIR/routes"

# 1) permissions.js
cat > "$SRC_DIR/constants/permissions.js" <<"EOF"
// src/constants/permissions.js

const PERMISSIONS = {
  TENANT_MANAGE: 'tenant:manage',
  STAFF_MANAGE: 'staff:manage',
  PLAYER_READ: 'player:read',
  PLAYER_WRITE: 'player:write',
  FINANCE_READ: 'finance:read',
  FINANCE_WRITE: 'finance:write',
  BET_LOG_READ: 'betlog:read',
};

const ROLES = {
  OPERATOR: 'operator',
  AGENT: 'agent',
  SUB_AGENT: 'subagent',
  CASHIER: 'cashier',
};

const ROLE_DEFAULT_PERMISSIONS = {
  operator: [
    PERMISSIONS.TENANT_MANAGE,
    PERMISSIONS.STAFF_MANAGE,
    PERMISSIONS.PLAYER_READ,
    PERMISSIONS.PLAYER_WRITE,
    PERMISSIONS.FINANCE_READ,
    PERMISSIONS.FINANCE_WRITE,
    PERMISSIONS.BET_LOG_READ,
  ],
  agent: [
    PERMISSIONS.PLAYER_READ,
    PERMISSIONS.PLAYER_WRITE,
    PERMISSIONS.FINANCE_READ,
    PERMISSIONS.FINANCE_WRITE,
    PERMISSIONS.BET_LOG_READ,
  ],
  subagent: [
    PERMISSIONS.PLAYER_READ,
    PERMISSIONS.FINANCE_READ,
    PERMISSIONS.BET_LOG_READ,
  ],
  cashier: [
    PERMISSIONS.PLAYER_READ,
    PERMISSIONS.FINANCE_WRITE,
  ],
};

module.exports = {
  PERMISSIONS,
  ROLES,
  ROLE_DEFAULT_PERMISSIONS,
};
EOF

# 2) StaffUser model
cat > "$SRC_DIR/models/StaffUser.js" <<"EOF"
// src/models/StaffUser.js

const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const StaffUser = sequelize.define(
  'StaffUser',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    tenantId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(160),
      allowNull: false,
      unique: true,
      validate: {
        isEmail: true,
      },
    },
    displayName: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },
    role: {
      type: DataTypes.ENUM('operator', 'agent', 'subagent', 'cashier'),
      allowNull: false,
    },
    passwordHash: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    permissions: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: false,
      defaultValue: [],
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  {
    tableName: 'staff_users',
    underscored: true,
    timestamps: true,
    indexes: [
      { fields: ['tenant_id'] },
      { unique: true, fields: ['email'] },
    ],
  }
);

module.exports = StaffUser;
EOF

# 3) staffAuthService.js
cat > "$SRC_DIR/services/staffAuthService.js" <<"EOF"
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
EOF

# 4) middleware/staffAuth.js
cat > "$SRC_DIR/middleware/staffAuth.js" <<"EOF"
// src/middleware/staffAuth.js

const jwt = require('jsonwebtoken');
const { StaffUser } = require('../models');

const JWT_SECRET = process.env.JWT_SECRET || 'development-secret-change-me';

function requireStaffAuth(requiredPermissions = []) {
  return async function staffAuthMiddleware(req, res, next) {
    try {
      const header = req.headers['authorization'] || '';
      const parts = header.split(' ');
      if (parts.length !== 2 || parts[0] !== 'Bearer') {
        return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      }

      const token = parts[1].trim();
      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch (err) {
        return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });
      }

      if (!decoded || decoded.type !== 'staff') {
        return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
      }

      const staff = await StaffUser.findByPk(decoded.sub);
      if (!staff || !staff.isActive) {
        return res.status(403).json({ ok: false, error: 'STAFF_INACTIVE' });
      }

      if (decoded.tenantId && staff.tenantId !== decoded.tenantId) {
        return res.status(403).json({ ok: false, error: 'TENANT_MISMATCH' });
      }

      const tokenPerms = Array.isArray(decoded.perms) ? decoded.perms : [];
      const dbPerms = Array.isArray(staff.permissions) ? staff.permissions : [];
      const effectivePerms = tokenPerms.length ? tokenPerms : dbPerms;

      if (Array.isArray(requiredPermissions) && requiredPermissions.length > 0) {
        const missing = requiredPermissions.filter(
          (p) => !effectivePerms.includes(p)
        );
        if (missing.length > 0) {
          return res.status(403).json({
            ok: false,
            error: 'INSUFFICIENT_PERMISSIONS',
            missing,
          });
        }
      }

      req.staff = {
        id: staff.id,
        tenantId: staff.tenantId,
        role: staff.role,
        permissions: effectivePerms,
      };

      return next();
    } catch (err) {
      console.error('staffAuth error', err);
      return res.status(500).json({ ok: false, error: 'AUTH_ERROR' });
    }
  };
}

module.exports = {
  requireStaffAuth,
};
EOF

# 5) routes/staffRoutes.js
cat > "$SRC_DIR/routes/staffRoutes.js" <<"EOF"
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
EOF

echo ">>> Staff PAM bundle files created."

echo ">>> Remember to:"
echo "  - Wire StaffUser into src/models/index.js"
echo "  - Mount routes in src/routes/index.js or app.js:"
echo "      router.use('/staff', require('./staffRoutes'));"
echo "  - Run migrations / sync so staff_users table exists."

echo ">>> Done."

