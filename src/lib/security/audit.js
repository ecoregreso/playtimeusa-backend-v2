const crypto = require("crypto");
const { QueryTypes } = require("sequelize");
const { sequelize } = require("../../db");

const AUDIT_HMAC_SECRET = process.env.AUDIT_HMAC_SECRET || "";

function isUuid(value) {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value)
  );
}

function canonicalize(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const out = {};
    for (const key of keys) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

async function getPrevHash(tenantId) {
  const replacements = {};
  let where = "tenant_id IS NULL";
  if (tenantId) {
    where = "tenant_id = :tenantId";
    replacements.tenantId = tenantId;
  }
  const rows = await sequelize.query(
    `
      SELECT hash
      FROM audit_log
      WHERE ${where}
      ORDER BY ts DESC, id DESC
      LIMIT 1
    `,
    { replacements, type: QueryTypes.SELECT }
  );
  return rows?.[0]?.hash || null;
}

async function writeAuditLog(payload = {}) {
  if (!AUDIT_HMAC_SECRET) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUDIT_HMAC_SECRET is required in production");
    }
    console.warn("[AUDIT] missing AUDIT_HMAC_SECRET, skipping audit log");
    return null;
  }

  const ts = new Date();
  const id = crypto.randomUUID();
  const tenantId = payload.tenantId || null;
  const actorId = isUuid(payload.actorId) ? payload.actorId : null;
  const prevHash = await getPrevHash(tenantId);

  const canonical = canonicalStringify({
    id,
    ts: ts.toISOString(),
    tenantId,
    actorType: payload.actorType || "system",
    actorId,
    action: payload.action || "unknown",
    entityType: payload.entityType || null,
    entityId: payload.entityId || null,
    before: payload.before || null,
    after: payload.after || null,
    requestId: payload.requestId || null,
    prevHash,
  });

  const hash = crypto.createHmac("sha256", AUDIT_HMAC_SECRET).update(canonical).digest("hex");

  try {
    await sequelize.query(
      `
        INSERT INTO audit_log (
          id, ts, tenant_id, actor_type, actor_id, action, entity_type, entity_id,
          before, after, request_id, prev_hash, hash
        ) VALUES (
          :id, :ts, :tenantId, :actorType, :actorId, :action, :entityType, :entityId,
          :before, :after, :requestId, :prevHash, :hash
        )
      `,
      {
        replacements: {
          id,
          ts,
          tenantId,
          actorType: payload.actorType || "system",
          actorId,
          action: payload.action || "unknown",
          entityType: payload.entityType || null,
          entityId: isUuid(payload.entityId) ? payload.entityId : null,
          before: payload.before ? JSON.stringify(payload.before) : null,
          after: payload.after ? JSON.stringify(payload.after) : null,
          requestId: payload.requestId || null,
          prevHash,
          hash,
        },
        type: QueryTypes.INSERT,
      }
    );
  } catch (err) {
    console.warn("[AUDIT] failed to insert audit log:", err.message || err);
  }

  return { id, hash, prevHash };
}

module.exports = {
  writeAuditLog,
  canonicalStringify,
};
