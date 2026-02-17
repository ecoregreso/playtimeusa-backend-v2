// src/routes/staffAuth.js
const express = require("express");
const bcrypt = require("bcryptjs");

const { StaffUser, Session } = require("../models");
const {
  requireStaffAuth,
  signStaffToken,
} = require("../middleware/staffAuth");
const { ROLE_DEFAULT_PERMISSIONS } = require("../constants/permissions");
const { initTenantContext } = require("../middleware/tenantContext");
const { emitSecurityEvent } = require("../lib/security/events");
const { getLock, recordFailure, recordSuccess } = require("../utils/lockout");
const { buildLimiter } = require("../utils/rateLimit");
const {
  normalizeTenantIdentifier,
  resolveTenantUuid,
} = require("../services/tenantIdentifierService");

const router = express.Router();
const staffLoginLimiter = buildLimiter({ windowMs: 15 * 60 * 1000, max: 20, message: "Too many staff login attempts" });

function buildPermissions(staff) {
  const explicit = Array.isArray(staff.permissions) ? staff.permissions : [];
  if (explicit.length) return Array.from(new Set(explicit));
  return ROLE_DEFAULT_PERMISSIONS[staff.role] || [];
}

// POST /api/v1/staff/login
router.post("/login", staffLoginLimiter, async (req, res) => {
  try {
    const { username, password, tenantId: rawTenantId } = req.body || {};

    const requestedTenantIdentifier = normalizeTenantIdentifier(rawTenantId);
    const tenantId = requestedTenantIdentifier
      ? await resolveTenantUuid(requestedTenantIdentifier)
      : null;
    const lockSubjectScope = requestedTenantIdentifier || tenantId || "owner";

    const usernameTrim = username ? String(username).trim() : "";

    if (!usernameTrim || !password) {
      emitSecurityEvent({
        tenantId: tenantId || null,
        actorType: "staff",
        actorId: null,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        method: req.method,
        path: req.originalUrl,
        requestId: req.requestId,
        eventType: "staff_login_failed",
        severity: 2,
        details: { username: usernameTrim || "unknown" },
      });
      return res
        .status(400)
        .json({ ok: false, error: "username and password are required" });
    }

    const lock = await getLock("staff", `${lockSubjectScope}:${usernameTrim}`, tenantId || null);
    if (lock.locked) {
      return res.status(429).json({ ok: false, error: "Account locked", lockUntil: lock.lockUntil });
    }

    if (requestedTenantIdentifier && !tenantId) {
      const fail = await recordFailure({
        subjectType: "staff",
        subjectId: `${lockSubjectScope}:${usernameTrim}`,
        tenantId: null,
        ip: req.auditContext?.ip,
        userAgent: req.auditContext?.userAgent,
      });
      if (fail.lockUntil) {
        emitSecurityEvent({
          tenantId: null,
          actorType: "staff",
          actorId: null,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          method: req.method,
          path: req.originalUrl,
          requestId: req.requestId,
          eventType: "lockout_triggered",
          severity: 3,
          details: { username: usernameTrim, lockUntil: fail.lockUntil },
        });
      }
      emitSecurityEvent({
        tenantId: null,
        actorType: "staff",
        actorId: null,
        ip: req.auditContext?.ip || null,
        userAgent: req.auditContext?.userAgent || null,
        method: req.method,
        path: req.originalUrl,
        requestId: req.requestId,
        eventType: "staff_login_failed",
        severity: 2,
        details: { username: usernameTrim },
      });
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    return await initTenantContext(
      req,
      res,
      {
        tenantId: tenantId || null,
        role: tenantId ? "staff" : "owner",
        userId: null,
        allowMissingTenant: !tenantId,
      },
      async () => {
        const staff = await StaffUser.findOne({
          where: tenantId
            ? {
                username: usernameTrim,
                tenantId,
              }
            : {
                username: usernameTrim,
                role: "owner",
              },
        });
        if (!staff || !staff.isActive) {
          const fail = await recordFailure({ subjectType: "staff", subjectId: `${lockSubjectScope}:${usernameTrim}`, tenantId: tenantId || null, ip: req.auditContext?.ip, userAgent: req.auditContext?.userAgent });
          if (fail.lockUntil) {
            emitSecurityEvent({
              tenantId: tenantId || null,
              actorType: "staff",
              actorId: null,
              ip: req.auditContext?.ip || null,
              userAgent: req.auditContext?.userAgent || null,
              method: req.method,
              path: req.originalUrl,
              requestId: req.requestId,
              eventType: "lockout_triggered",
              severity: 3,
              details: { username: usernameTrim, lockUntil: fail.lockUntil },
            });
          }
          emitSecurityEvent({
            tenantId: tenantId || null,
            actorType: "staff",
            actorId: null,
            ip: req.auditContext?.ip || null,
            userAgent: req.auditContext?.userAgent || null,
            method: req.method,
            path: req.originalUrl,
            requestId: req.requestId,
            eventType: "staff_login_failed",
            severity: 2,
            details: { username: usernameTrim },
          });
          return res.status(401).json({ ok: false, error: "Invalid credentials" });
        }

        const ok = await bcrypt.compare(password, staff.passwordHash);
        if (!ok) {
          const fail = await recordFailure({ subjectType: "staff", subjectId: `${lockSubjectScope}:${usernameTrim}`, tenantId: tenantId || null, ip: req.auditContext?.ip, userAgent: req.auditContext?.userAgent });
          if (fail.lockUntil) {
            emitSecurityEvent({
              tenantId: tenantId || null,
              actorType: "staff",
              actorId: null,
              ip: req.auditContext?.ip || null,
              userAgent: req.auditContext?.userAgent || null,
              method: req.method,
              path: req.originalUrl,
              requestId: req.requestId,
              eventType: "lockout_triggered",
              severity: 3,
              details: { username: usernameTrim, lockUntil: fail.lockUntil },
            });
          }
          emitSecurityEvent({
            tenantId: tenantId || null,
            actorType: "staff",
            actorId: null,
            ip: req.auditContext?.ip || null,
            userAgent: req.auditContext?.userAgent || null,
            method: req.method,
            path: req.originalUrl,
            requestId: req.requestId,
            eventType: "staff_login_failed",
            severity: 2,
            details: { username: usernameTrim },
          });
          return res.status(401).json({ ok: false, error: "Invalid credentials" });
        }

        const permissions = buildPermissions(staff);
        const token = signStaffToken({ ...staff.toJSON(), permissions });
        await recordSuccess({ subjectType: "staff", subjectId: `${lockSubjectScope}:${usernameTrim}`, tenantId: tenantId || null });
        emitSecurityEvent({
          tenantId: staff.tenantId || tenantId || null,
          actorType: staff.role === "owner" ? "owner" : "staff",
          actorId: null,
          ip: req.auditContext?.ip || null,
          userAgent: req.auditContext?.userAgent || null,
          method: req.method,
          path: req.originalUrl,
          requestId: req.requestId,
          eventType: "staff_login_success",
          severity: 1,
          details: { username: staff.username },
        });

        // record session for monitoring
        try {
          await Session.create({
            tenantId: staff.tenantId,
            actorType: "staff",
            userId: String(staff.id),
            role: staff.role,
            lastSeenAt: new Date(),
          });
        } catch (err) {
          console.warn("[STAFF_LOGIN] failed to record session:", err.message);
        }

        return res.json({
          ok: true,
          token,
          tokens: {
            accessToken: token,
          },
          staff: {
            id: staff.id,
            username: staff.username,
            role: staff.role,
            isActive: staff.isActive,
            tenantId: staff.tenantId,
            permissions,
            agentCode: staff.agentCode,
            parentId: staff.parentId,
          },
        });
      }
    );
  } catch (err) {
    console.error("[STAFF_LOGIN] error:", err);
    const status = err.status || 500;
    return res.status(status).json({ ok: false, error: err.message || "Internal error" });
  }
});

// GET /api/v1/staff/me
router.get("/me", requireStaffAuth(), async (req, res) => {
  return res.json({
    ok: true,
    staff: req.staff,
  });
});

module.exports = router;
