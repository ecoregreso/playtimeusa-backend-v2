const crypto = require("crypto");
const { QueryTypes } = require("sequelize");
const { sequelize } = require("../../db");
const { runRules } = require("./rules");

const SENSITIVE_KEYS = [
  "password",
  "pin",
  "token",
  "secret",
  "accessToken",
  "refreshToken",
  "authorization",
];

function isUuid(value) {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value)
  );
}

function maskCode(value, visible = 2) {
  if (!value) return null;
  const raw = String(value);
  if (raw.length <= visible) return raw;
  return `${"*".repeat(raw.length - visible)}${raw.slice(-visible)}`;
}

function sanitizeDetails(details) {
  if (!details || typeof details !== "object") return {};
  const out = { ...details };
  for (const key of Object.keys(out)) {
    if (SENSITIVE_KEYS.some((bad) => key.toLowerCase().includes(bad.toLowerCase()))) {
      delete out[key];
    }
  }
  return out;
}

async function emitSecurityEvent(payload = {}) {
  const event = {
    id: crypto.randomUUID(),
    ts: new Date(),
    tenantId: payload.tenantId || null,
    actorType: payload.actorType || "system",
    actorId: isUuid(payload.actorId) ? payload.actorId : null,
    ip: payload.ip || null,
    userAgent: payload.userAgent || null,
    method: payload.method || null,
    path: payload.path || null,
    requestId: payload.requestId || null,
    eventType: payload.eventType || "unknown",
    severity: Number(payload.severity || 1),
    details: sanitizeDetails(payload.details || {}),
  };

  try {
    await sequelize.query(
      `
        INSERT INTO security_events (
          id, ts, tenant_id, actor_type, actor_id, ip, user_agent, method, path, request_id,
          event_type, severity, details
        ) VALUES (
          :id, :ts, :tenantId, :actorType, :actorId, :ip, :userAgent, :method, :path, :requestId,
          :eventType, :severity, :details
        )
      `,
      {
        replacements: {
          id: event.id,
          ts: event.ts,
          tenantId: event.tenantId,
          actorType: event.actorType,
          actorId: event.actorId,
          ip: event.ip,
          userAgent: event.userAgent,
          method: event.method,
          path: event.path,
          requestId: event.requestId,
          eventType: event.eventType,
          severity: event.severity,
          details: JSON.stringify(event.details),
        },
        type: QueryTypes.INSERT,
      }
    );
  } catch (err) {
    console.warn("[SECURITY] failed to insert event:", err.message || err);
  }

  try {
    await runRules(event);
  } catch (err) {
    console.warn("[SECURITY] rules engine error:", err.message || err);
  }

  return event;
}

module.exports = {
  emitSecurityEvent,
  maskCode,
};
