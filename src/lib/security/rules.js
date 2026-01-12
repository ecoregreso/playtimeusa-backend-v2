const crypto = require("crypto");
const { QueryTypes } = require("sequelize");
const { sequelize } = require("../../db");

const WINDOW_MINUTES = Number(process.env.SECURITY_RULE_WINDOW_MINUTES || 10);
const DEDUPE_MINUTES = Number(process.env.SECURITY_ALERT_DEDUP_MINUTES || 30);

const RULES = {
  IP_BRUTE_FORCE: "rule:staff_login_failed:ip",
  USERNAME_BRUTE_FORCE: "rule:staff_login_failed:username",
  VOUCHER_PIN_GUESS: "rule:voucher_pin_failed:masked_code",
  ACCESS_VIOLATION: "rule:access_violation",
  PLAYER_LOGIN_FAILED: "rule:player_login_failed:masked_code",
};

function buildSince(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000);
}

function normalizeKey(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

async function countEvents({ eventType, ip, username, maskedCode, since, tenantId }) {
  const clauses = [`event_type = :eventType`, `ts >= :since`];
  const replacements = { eventType, since };

  if (ip) {
    clauses.push(`ip = :ip`);
    replacements.ip = ip;
  }
  if (username) {
    clauses.push(`details->>'username' = :username`);
    replacements.username = username;
  }
  if (maskedCode) {
    clauses.push(`details->>'maskedCode' = :maskedCode`);
    replacements.maskedCode = maskedCode;
  }
  if (tenantId) {
    clauses.push("tenant_id = :tenantId");
    replacements.tenantId = tenantId;
  }

  const sql = `
    SELECT COUNT(*)::int AS count
    FROM security_events
    WHERE ${clauses.join(" AND ")}
  `;
  const rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  return Number(rows?.[0]?.count || 0);
}

async function findOpenAlert({ ruleId, tenantId, keyFields }) {
  const clauses = ["status = 'open'", "rule_id = :ruleId", "ts >= :since"];
  const replacements = {
    ruleId,
    since: buildSince(DEDUPE_MINUTES),
  };

  if (tenantId) {
    clauses.push("tenant_id = :tenantId");
    replacements.tenantId = tenantId;
  } else {
    clauses.push("tenant_id IS NULL");
  }

  for (const [key, value] of Object.entries(keyFields || {})) {
    clauses.push(`details->>'${key}' = :${key}`);
    replacements[key] = String(value);
  }

  const sql = `
    SELECT id, details, ts
    FROM security_alerts
    WHERE ${clauses.join(" AND ")}
    ORDER BY ts DESC
    LIMIT 1
  `;
  const rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  return rows?.[0] || null;
}

async function upsertAlert({ tenantId, severity, ruleId, title, keyFields }) {
  const existing = await findOpenAlert({ ruleId, tenantId, keyFields });
  const now = new Date().toISOString();

  if (existing) {
    const details = typeof existing.details === "object" && existing.details ? { ...existing.details } : {};
    const currentCount = Number(details.count || 0);
    details.count = currentCount + 1;
    details.last_seen = now;
    for (const [key, value] of Object.entries(keyFields || {})) {
      if (!(key in details)) {
        details[key] = value;
      }
    }
    await sequelize.query(
      `
        UPDATE security_alerts
        SET details = :details
        WHERE id = :id
      `,
      {
        replacements: {
          id: existing.id,
          details: JSON.stringify(details),
        },
        type: QueryTypes.UPDATE,
      }
    );
    return existing.id;
  }

  const details = {
    ...keyFields,
    count: 1,
    first_seen: now,
    last_seen: now,
  };

  const id = crypto.randomUUID();
  await sequelize.query(
    `
      INSERT INTO security_alerts (
        id, ts, tenant_id, severity, rule_id, title, details, status
      ) VALUES (
        :id, :ts, :tenantId, :severity, :ruleId, :title, :details, 'open'
      )
    `,
    {
      replacements: {
        id,
        ts: new Date(),
        tenantId: tenantId || null,
        severity,
        ruleId,
        title,
        details: JSON.stringify(details),
      },
      type: QueryTypes.INSERT,
    }
  );
  return id;
}

async function runRules(event) {
  if (!event || !event.eventType) return;

  const tenantId = event.tenantId || null;
  const since = buildSince(WINDOW_MINUTES);

  if (event.eventType === "staff_login_failed") {
    const ip = normalizeKey(event.ip);
    const username = normalizeKey(event.details?.username);

    if (ip) {
      const count = await countEvents({ eventType: event.eventType, ip, since, tenantId });
      if (count >= 10) {
        await upsertAlert({
          tenantId,
          severity: 3,
          ruleId: RULES.IP_BRUTE_FORCE,
          title: "Staff login brute force suspected",
          keyFields: { ip },
        });
      }
    }

    if (username) {
      const count = await countEvents({ eventType: event.eventType, username, since, tenantId });
      if (count >= 10) {
        await upsertAlert({
          tenantId,
          severity: 3,
          ruleId: RULES.USERNAME_BRUTE_FORCE,
          title: "Staff username under attack",
          keyFields: { username },
        });
      }
    }
  }

  if (event.eventType === "voucher_pin_failed") {
    const maskedCode = normalizeKey(event.details?.maskedCode);
    if (maskedCode) {
      const count = await countEvents({ eventType: event.eventType, maskedCode, since, tenantId });
      if (count >= 8) {
        await upsertAlert({
          tenantId,
          severity: 3,
          ruleId: RULES.VOUCHER_PIN_GUESS,
          title: "Voucher PIN guessing suspected",
          keyFields: { maskedCode },
        });
      }
    }
  }

  if (event.eventType === "access_violation") {
    const path = normalizeKey(event.path || event.details?.path);
    const actor = normalizeKey(event.details?.actorId || event.actorId);
    await upsertAlert({
      tenantId,
      severity: 3,
      ruleId: RULES.ACCESS_VIOLATION,
      title: "Access violation detected",
      keyFields: { path: path || "unknown", actor: actor || "unknown" },
    });
  }

  if (event.eventType === "player_login_failed") {
    const maskedCode = normalizeKey(event.details?.maskedCode);
    const ip = normalizeKey(event.ip);
    if (maskedCode) {
      const count = await countEvents({ eventType: event.eventType, maskedCode, since, tenantId });
      if (count >= 3) {
        await upsertAlert({
          tenantId,
          severity: 2,
          ruleId: RULES.PLAYER_LOGIN_FAILED,
          title: "Player login failures detected",
          keyFields: { maskedCode, ip: ip || "unknown" },
        });
      }
    }
  }
}

module.exports = {
  runRules,
};
