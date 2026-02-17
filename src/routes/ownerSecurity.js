const express = require("express");
const { QueryTypes } = require("sequelize");
const { sequelize } = require("../db");
const { staffAuth } = require("../middleware/staffAuth");
const { emitSecurityEvent } = require("../lib/security/events");
const { normalizeTenantIdentifier, resolveTenantUuid } = require("../services/tenantIdentifierService");

const router = express.Router();

function parseLimit(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function encodeCursor(row) {
  if (!row) return null;
  const payload = { ts: row.ts, id: row.id };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(String(cursor), "base64").toString("utf8");
    const parsed = JSON.parse(raw);
    return parsed && parsed.ts && parsed.id ? parsed : null;
  } catch {
    return null;
  }
}

function isUuid(value) {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value)
  );
}

function requireOwner(req, res, next) {
  if (!req.staff) return res.status(401).json({ ok: false, error: "Unauthorized" });
  if (req.staff.role !== "owner") {
    emitSecurityEvent({
      tenantId: req.staff?.tenantId || null,
      actorType: "staff",
      actorId: null,
      ip: req.auditContext?.ip || null,
      userAgent: req.auditContext?.userAgent || null,
      method: req.method,
      path: req.originalUrl,
      requestId: req.requestId,
      eventType: "access_violation",
      severity: 3,
      details: {
        reason: "owner_route_forbidden",
        staffId: String(req.staff?.id || ""),
        path: req.originalUrl,
      },
    });
    return res.status(403).json({ ok: false, error: "Owner access required" });
  }
  if (req.staff?.tenantId) {
    emitSecurityEvent({
      tenantId: req.staff.tenantId,
      actorType: "owner",
      actorId: null,
      ip: req.auditContext?.ip || null,
      userAgent: req.auditContext?.userAgent || null,
      method: req.method,
      path: req.originalUrl,
      requestId: req.requestId,
      eventType: "access_violation",
      severity: 3,
      details: {
        reason: "owner_token_scoped_to_tenant",
        tenantId: req.staff.tenantId,
        path: req.originalUrl,
      },
    });
  }
  return next();
}

router.get("/alerts", staffAuth, requireOwner, async (req, res) => {
  try {
    const status = String(req.query.status || "open").trim() || "open";
    const tenantIdentifier = normalizeTenantIdentifier(req.query.tenantId || null);
    const tenantId = tenantIdentifier ? await resolveTenantUuid(tenantIdentifier) : null;
    if (tenantIdentifier && !tenantId) {
      return res.json({ ok: true, alerts: [], nextCursor: null });
    }
    const limit = parseLimit(req.query.limit, 50, 200);
    const cursor = decodeCursor(req.query.cursor);

    const clauses = ["status = :status"];
    const replacements = { status };
    if (tenantId) {
      clauses.push("tenant_id = :tenantId");
      replacements.tenantId = tenantId;
    }

    if (cursor) {
      clauses.push("(ts < :cursorTs OR (ts = :cursorTs AND id < :cursorId))");
      replacements.cursorTs = cursor.ts;
      replacements.cursorId = cursor.id;
    }

    const rows = await sequelize.query(
      `
        SELECT *
        FROM security_alerts
        WHERE ${clauses.join(" AND ")}
        ORDER BY ts DESC, id DESC
        LIMIT :limit
      `,
      {
        replacements: { ...replacements, limit: limit + 1 },
        type: QueryTypes.SELECT,
      }
    );
    const items = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeCursor(rows[limit]) : null;
    res.json({ ok: true, alerts: items, nextCursor });
  } catch (err) {
    console.error("[OWNER_SECURITY] alerts list error:", err);
    res.status(500).json({ ok: false, error: "Failed to load alerts" });
  }
});

router.post("/alerts/:id/ack", staffAuth, requireOwner, async (req, res) => {
  try {
    await sequelize.query(
      `
        UPDATE security_alerts
        SET status = 'ack',
            acknowledged_by = :by,
            acknowledged_at = now()
        WHERE id = :id
      `,
      {
        replacements: {
          id: req.params.id,
          by: isUuid(req.staff?.id) ? String(req.staff.id) : null,
        },
        type: QueryTypes.UPDATE,
      }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[OWNER_SECURITY] ack error:", err);
    res.status(500).json({ ok: false, error: "Failed to acknowledge alert" });
  }
});

router.post("/alerts/:id/close", staffAuth, requireOwner, async (req, res) => {
  try {
    await sequelize.query(
      `
        UPDATE security_alerts
        SET status = 'closed',
            closed_by = :by,
            closed_at = now()
        WHERE id = :id
      `,
      {
        replacements: {
          id: req.params.id,
          by: isUuid(req.staff?.id) ? String(req.staff.id) : null,
        },
        type: QueryTypes.UPDATE,
      }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[OWNER_SECURITY] close error:", err);
    res.status(500).json({ ok: false, error: "Failed to close alert" });
  }
});

router.get("/events", staffAuth, requireOwner, async (req, res) => {
  try {
    const tenantIdentifier = normalizeTenantIdentifier(req.query.tenantId || null);
    const tenantId = tenantIdentifier ? await resolveTenantUuid(tenantIdentifier) : null;
    if (tenantIdentifier && !tenantId) {
      return res.json({ ok: true, events: [], nextCursor: null });
    }
    const severityMin = req.query.severityMin ? Number(req.query.severityMin) : null;
    const eventType = req.query.eventType ? String(req.query.eventType).trim() : null;
    const limit = parseLimit(req.query.limit, 100, 500);
    const cursor = decodeCursor(req.query.cursor);

    const clauses = ["1=1"];
    const replacements = {};
    if (tenantId) {
      clauses.push("tenant_id = :tenantId");
      replacements.tenantId = tenantId;
    }
    if (Number.isFinite(severityMin)) {
      clauses.push("severity >= :severityMin");
      replacements.severityMin = severityMin;
    }
    if (eventType) {
      clauses.push("event_type = :eventType");
      replacements.eventType = eventType;
    }
    if (cursor) {
      clauses.push("(ts < :cursorTs OR (ts = :cursorTs AND id < :cursorId))");
      replacements.cursorTs = cursor.ts;
      replacements.cursorId = cursor.id;
    }

    const rows = await sequelize.query(
      `
        SELECT *
        FROM security_events
        WHERE ${clauses.join(" AND ")}
        ORDER BY ts DESC, id DESC
        LIMIT :limit
      `,
      {
        replacements: { ...replacements, limit: limit + 1 },
        type: QueryTypes.SELECT,
      }
    );
    const items = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeCursor(rows[limit]) : null;
    res.json({ ok: true, events: items, nextCursor });
  } catch (err) {
    console.error("[OWNER_SECURITY] events list error:", err);
    res.status(500).json({ ok: false, error: "Failed to load events" });
  }
});

router.get("/summary", staffAuth, requireOwner, async (req, res) => {
  const windowMinutes = parseLimit(req.query.windowMinutes, 60, 1440);
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);

  try {
    const [severityRows, ipRows, alertRows] = await Promise.all([
      sequelize.query(
        `
          SELECT severity, COUNT(*)::int AS count
          FROM security_events
          WHERE ts >= :since
          GROUP BY severity
        `,
        { replacements: { since }, type: QueryTypes.SELECT }
      ),
      sequelize.query(
        `
          SELECT ip, COUNT(*)::int AS count
          FROM security_events
          WHERE ts >= :since
            AND event_type = 'staff_login_failed'
            AND ip IS NOT NULL
          GROUP BY ip
          ORDER BY count DESC
          LIMIT 5
        `,
        { replacements: { since }, type: QueryTypes.SELECT }
      ),
      sequelize.query(
        `
          SELECT *
          FROM security_alerts
          WHERE status = 'open'
          ORDER BY ts DESC
          LIMIT 10
        `,
        { type: QueryTypes.SELECT }
      ),
    ]);

    const severityCounts = severityRows.reduce((acc, row) => {
      acc[row.severity] = Number(row.count || 0);
      return acc;
    }, {});

    res.json({
      ok: true,
      windowMinutes,
      severityCounts,
      topIps: ipRows.map((row) => ({ ip: row.ip, count: Number(row.count || 0) })),
      latestAlerts: alertRows,
    });
  } catch (err) {
    console.error("[OWNER_SECURITY] summary error:", err);
    res.status(500).json({ ok: false, error: "Failed to load summary" });
  }
});

module.exports = router;
