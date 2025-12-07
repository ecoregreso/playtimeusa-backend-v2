// src/services/staffAuthService.js
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { StaffUser } = require("../models");
const {
  ROLE_DEFAULT_PERMISSIONS,
} = require("../constants/permissions");

const STAFF_JWT_SECRET =
  process.env.STAFF_JWT_SECRET || process.env.JWT_SECRET;
const STAFF_JWT_TTL = process.env.STAFF_JWT_TTL || "12h";

if (!STAFF_JWT_SECRET) {
  console.warn(
    "[STAFF_AUTH] No STAFF_JWT_SECRET configured; using JWT_SECRET or failing hard."
  );
}

function buildEffectivePermissions(staff) {
  const base =
    staff.permissions && staff.permissions.length
      ? staff.permissions
      : ROLE_DEFAULT_PERMISSIONS[staff.role] || [];
  // Ensure uniqueness
  return Array.from(new Set(base));
}

async function authenticateStaff({ email, password }) {
  const normalizedEmail = (email || "").toLowerCase().trim();
  if (!normalizedEmail || !password) {
    throw new Error("Missing email or password");
  }

  const staff = await StaffUser.findOne({
    where: { email: normalizedEmail },
  });

  if (!staff) {
    throw new Error("Invalid credentials");
  }

  if (!staff.isActive) {
    throw new Error("Staff user is inactive");
  }

  const ok = await bcrypt.compare(password, staff.passwordHash);
  if (!ok) {
    throw new Error("Invalid credentials");
  }

  const perms = buildEffectivePermissions(staff);

  const payload = {
    sub: staff.id,
    type: "staff",
    role: staff.role,
    tenantId: staff.tenantId || null,
    perms,
  };

  const token = jwt.sign(payload, STAFF_JWT_SECRET, {
    expiresIn: STAFF_JWT_TTL,
  });

  return {
    token,
    staff: {
      id: staff.id,
      email: staff.email,
      displayName: staff.displayName,
      role: staff.role,
      tenantId: staff.tenantId,
      permissions: perms,
    },
  };
}

async function createStaffUser({
  email,
  password,
  role,
  displayName,
  tenantId = null,
  permissions = null,
}) {
  const normalizedEmail = (email || "").toLowerCase().trim();
  if (!normalizedEmail || !password || !role) {
    throw new Error("Missing required fields for staff user");
  }

  const hash = await bcrypt.hash(password, 10);

  const effectivePerms =
    permissions && permissions.length
      ? permissions
      : ROLE_DEFAULT_PERMISSIONS[role] || [];

  const staff = await StaffUser.create({
    email: normalizedEmail,
    passwordHash: hash,
    role,
    displayName,
    tenantId,
    permissions: effectivePerms,
  });

  return staff;
}

module.exports = {
  authenticateStaff,
  createStaffUser,
};
