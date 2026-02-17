// src/routes/ownerTenants.js
// Owner console routes (global / multi-tenant admin)

const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { Op, QueryTypes } = require("sequelize");

const {
  Tenant,
  Distributor,
  TenantWallet,
  TenantVoucherPool,
  CreditLedger,
  PurchaseOrder,
  OwnerSetting,
  StaffUser,
  StaffMessage,
} = require("../models");

const { sequelize } = require("../db");
const { staffAuth, requirePermission } = require("../middleware/staffAuth");
const { PERMISSIONS, ROLE_DEFAULT_PERMISSIONS, ROLES } = require("../constants/permissions");
const { getJson, setJson, safeParseJson, setSetting, getSetting } = require("../utils/ownerSettings");
const {
  DEFAULT_VOUCHER_WIN_CAP_POLICY,
  normalizeVoucherWinCapPolicy,
} = require("../services/voucherWinCapPolicyService");
const {
  DEFAULT_OUTCOME_MODE,
  normalizeOutcomeMode,
} = require("../services/outcomeModeService");
const { wipeAllData, wipeTenantData } = require("../services/wipeService");
const { emitSecurityEvent } = require("../lib/security/events");
const { writeAuditLog } = require("../lib/security/audit");
const {
  normalizeTenantIdentifier,
  isUuidLike,
  findTenantByIdentifier,
  isTenantIdentifierTaken,
} = require("../services/tenantIdentifierService");

const router = express.Router();

const BRAND_KEY = "brand";
const SYSTEM_CONFIG_KEY = "system_config";

function tenantConfigKey(tenantId) {
  return `tenant:${tenantId}:config`;
}

function rootStaffKey(tenantId) {
  return `tenant:${tenantId}:root_staff_id`;
}

function adminUiBase() {
  const raw =
    process.env.ADMIN_UI_BASE_URL ||
    process.env.ADMIN_UI_BASE ||
    process.env.ADMIN_UI_URL ||
    "";
  return String(raw || "").replace(/\/+$/, "");
}

function randomPassword(length = 14) {
  // Avoid ambiguous characters (0/O, 1/l/I)
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function buildTenantLoginUrl(tenant = null) {
  const identifier = tenant?.externalId || tenant?.id || "";
  const encodedIdentifier = encodeURIComponent(String(identifier));
  const base = adminUiBase();
  return base ? `${base}/login?tenantId=${encodedIdentifier}` : `/login?tenantId=${encodedIdentifier}`;
}

async function resolveTenantFromAnyId(rawTenantIdentifier, options = {}) {
  const tenantIdentifier = normalizeTenantIdentifier(rawTenantIdentifier);
  if (!tenantIdentifier) {
    return { tenantIdentifier: null, tenantId: null, tenant: null };
  }

  const tenant = await findTenantByIdentifier(tenantIdentifier, options);
  return {
    tenantIdentifier,
    tenantId: tenant?.id || null,
    tenant: tenant || null,
  };
}

async function ensureUniqueUsername({ tenantId, desired }, transaction) {
  const base = desired && String(desired).trim() ? String(desired).trim() : "admin";
  const normalized = base.slice(0, 48);

  let candidate = normalized;
  let attempt = 0;

  while (attempt < 20) {
    const existing = await StaffUser.findOne({
      where: { tenantId, username: candidate },
      transaction,
      lock: transaction ? transaction.LOCK.UPDATE : undefined,
    });
    if (!existing) return candidate;

    attempt += 1;
    const suffix = String(Math.floor(Math.random() * 9000) + 1000);
    candidate = `${normalized.slice(0, 48 - suffix.length - 1)}-${suffix}`;
  }

  // last-resort (very unlikely)
  return `${normalized.slice(0, 40)}-${crypto.randomBytes(3).toString("hex")}`;
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

function clampCents(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

async function withRequestTransaction(req, handler) {
  if (req?.transaction) {
    return sequelize.transaction({ transaction: req.transaction }, handler);
  }
  return sequelize.transaction(handler);
}

async function tryAuditLog(payload) {
  try {
    await writeAuditLog(payload);
  } catch (err) {
    console.warn("[OWNER] audit log failed:", err.message || err);
  }
}

const DEFAULT_SYSTEM_CONFIG = {
  maintenanceMode: false,
  purchaseOrdersEnabled: true,
  vouchersEnabled: true,
  depositsEnabled: true,
  withdrawalsEnabled: true,
  messagingEnabled: true,
  pushEnabled: true,
  outcomeMode: DEFAULT_OUTCOME_MODE,
  voucherWinCapPolicy: { ...DEFAULT_VOUCHER_WIN_CAP_POLICY },
};

async function getSystemConfig() {
  const cfg = await getJson(SYSTEM_CONFIG_KEY, null);
  if (!cfg || typeof cfg !== "object") return { ...DEFAULT_SYSTEM_CONFIG };
  const merged = { ...DEFAULT_SYSTEM_CONFIG, ...cfg };
  merged.outcomeMode = normalizeOutcomeMode(merged.outcomeMode, DEFAULT_OUTCOME_MODE);
  merged.voucherWinCapPolicy = normalizeVoucherWinCapPolicy(merged.voucherWinCapPolicy);
  return merged;
}

const OWNER_ANALYTICS_DEFAULT_DAYS = 30;
const OWNER_ANALYTICS_MAX_DAYS = 365;

function parseDateInput(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Date(`${raw}T00:00:00.000Z`);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parseOwnerAnalyticsRange(query = {}) {
  const rawDays = Number.parseInt(String(query.days || OWNER_ANALYTICS_DEFAULT_DAYS), 10);
  const days = Number.isFinite(rawDays)
    ? Math.min(Math.max(rawDays, 1), OWNER_ANALYTICS_MAX_DAYS)
    : OWNER_ANALYTICS_DEFAULT_DAYS;

  const fromInput = parseDateInput(query.from || query.start);
  const toInput = parseDateInput(query.to || query.end);

  let startDate = fromInput;
  let endDate = toInput;

  if (!startDate && !endDate) {
    const now = new Date();
    endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
  } else if (!startDate) {
    startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
  } else if (!endDate) {
    endDate = new Date(startDate);
    endDate.setUTCDate(endDate.getUTCDate() + (days - 1));
  }

  if (startDate > endDate) {
    const tmp = startDate;
    startDate = endDate;
    endDate = tmp;
  }

  const startUtc = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
  const endUtc = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));
  const endDateExclusive = new Date(endUtc);
  endDateExclusive.setUTCDate(endDateExclusive.getUTCDate() + 1);

  return {
    startDate: startUtc,
    endDate: endUtc,
    endDateExclusive,
    from: startUtc.toISOString(),
    to: endUtc.toISOString(),
    days,
  };
}

function toNumeric(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toMoney(cents) {
  return Number((toNumeric(cents, 0) / 100).toFixed(2));
}

function dayKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function buildDayBuckets(startDate, endDateExclusive) {
  const out = [];
  const cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate()));
  while (cursor < endDateExclusive) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function indexByTenant(rows, key = "tenantId") {
  const map = new Map();
  for (const row of rows || []) {
    const tenantId = row?.[key];
    if (!tenantId) continue;
    map.set(String(tenantId), row);
  }
  return map;
}

// --------------------
// Owner inbox (cross-tenant messages)
// --------------------

router.get("/inbox", staffAuth, requireOwner, async (req, res) => {
  const limitRaw = parseInt(req.query.limit || "50", 10);
  const offsetRaw = parseInt(req.query.offset || "0", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

  try {
    const where = { toId: req.staff?.id };

    const [messages, unreadCount] = await Promise.all([
      StaffMessage.findAll({
        where,
        order: [["createdAt", "DESC"]],
        limit,
        offset,
      }),
      StaffMessage.count({
        where: { ...where, readAt: null },
      }),
    ]);

    const staffIds = Array.from(
      new Set(messages.flatMap((m) => [m.fromId, m.toId]).filter(Boolean))
    );
    const staffRows = staffIds.length
      ? await StaffUser.findAll({ where: { id: staffIds } })
      : [];
    const staffById = new Map(staffRows.map((s) => [s.id, s]));

    res.json({
      ok: true,
      unreadCount,
      messages: messages.map((m) => ({
        id: m.id,
        threadId: m.threadId,
        fromId: m.fromId,
        toId: m.toId,
        tenantId: m.tenantId,
        type: m.type,
        ciphertext: m.ciphertext,
        createdAt: m.createdAt,
        readAt: m.readAt,
        fromUsername: staffById.get(m.fromId)?.username || null,
        toUsername: staffById.get(m.toId)?.username || null,
      })),
    });
  } catch (err) {
    console.error("[OWNER] inbox error:", err);
    res.status(500).json({ ok: false, error: "Failed to load inbox" });
  }
});

// --------------------
// Brand control
// --------------------

router.get(
  "/brand",
  staffAuth,
  requireOwner,
  async (req, res) => {
    try {
      const row = await OwnerSetting.findByPk(BRAND_KEY);
      const brand = row ? safeParseJson(row.value, {}) : {};
      res.json({ ok: true, brand });
    } catch (err) {
      console.error("[OWNER] brand load error:", err);
      res.status(500).json({ ok: false, error: "Failed to load brand" });
    }
  }
);

router.post(
  "/brand",
  staffAuth,
  requireOwner,
  async (req, res) => {
    try {
      const brand = req.body?.brand;
      if (!brand || typeof brand !== "object") {
        return res.status(400).json({ ok: false, error: "brand must be an object" });
      }
      await OwnerSetting.upsert({
        key: BRAND_KEY,
        value: JSON.stringify(brand),
      });
      res.json({ ok: true });
    } catch (err) {
      console.error("[OWNER] brand save error:", err);
      res.status(500).json({ ok: false, error: "Failed to save brand" });
    }
  }
);

// --------------------
// System config (global)
// --------------------

async function handleGetSystemConfig(req, res) {
  try {
    const config = await getSystemConfig();
    res.json({ ok: true, config });
  } catch (err) {
    console.error("[OWNER] system config get error:", err);
    res.status(500).json({ ok: false, error: "Failed to load system config" });
  }
}

async function handleSetSystemConfig(req, res) {
  try {
    const patch = req.body?.config;
    if (!patch || typeof patch !== "object") {
      return res.status(400).json({ ok: false, error: "config must be an object" });
    }
    const current = await getSystemConfig();
    const merged = { ...current, ...patch };
    if (Object.prototype.hasOwnProperty.call(patch, "outcomeMode")) {
      merged.outcomeMode = normalizeOutcomeMode(patch.outcomeMode, current.outcomeMode);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "voucherWinCapPolicy")) {
      merged.voucherWinCapPolicy = normalizeVoucherWinCapPolicy(patch.voucherWinCapPolicy);
    }
    await setJson(SYSTEM_CONFIG_KEY, merged);
    res.json({ ok: true, config: merged });
  } catch (err) {
    console.error("[OWNER] system config set error:", err);
    res.status(500).json({ ok: false, error: "Failed to save system config" });
  }
}

router.get("/config/system", staffAuth, requireOwner, handleGetSystemConfig);
router.post("/config/system", staffAuth, requireOwner, handleSetSystemConfig);
router.put("/config/system", staffAuth, requireOwner, handleSetSystemConfig);

// --------------------
// Tenants (tenant === distributor)
// --------------------

router.get(
  "/tenants",
  staffAuth,
  requireOwner,
  async (req, res) => {
    try {
      const tenants = await Tenant.findAll({
        include: [
          { model: Distributor },
          { model: TenantWallet },
          { model: TenantVoucherPool },
        ],
        order: [["createdAt", "DESC"]],
      });

      // Attach root admin info (best-effort)
      const roots = await OwnerSetting.findAll({
        where: { key: { [Op.like]: "tenant:%:root_staff_id" } },
      });
      const tenantToStaffId = new Map()
      for (const r of roots) {
        const k = String(r.key || "");
        const match = k.match(/^tenant:([^:]+):root_staff_id$/);
        if (!match) continue;
        tenantToStaffId.set(match[1], String(r.value || ""));
      }

      const staffIds = [...new Set([...tenantToStaffId.values()].filter(Boolean))];
      const staffRows = staffIds.length
        ? await StaffUser.findAll({ where: { id: staffIds.map((v) => Number(v)).filter((n) => Number.isFinite(n)) } })
        : [];
      const staffById = new Map(staffRows.map((s) => [String(s.id), s]));

      const payload = tenants.map((t) => {
        const obj = t.toJSON();
        const rootId = tenantToStaffId.get(obj.id) || null;
        const root = rootId ? staffById.get(String(rootId)) : null;
        return {
          ...obj,
          rootAdmin: root
            ? { id: root.id, username: root.username, email: root.email, role: root.role }
            : rootId
            ? { id: rootId, username: null }
            : null,
        };
      });

      res.json({ ok: true, tenants: payload });
    } catch (err) {
      console.error("[OWNER] tenants list error:", err);
      res.status(500).json({ ok: false, error: "Failed to load tenants" });
    }
  }
);

router.get(
  "/analytics/tenants",
  staffAuth,
  requireOwner,
  async (req, res) => {
    try {
      const range = parseOwnerAnalyticsRange(req.query || {});
      const replacements = {
        startDate: range.startDate,
        endDateExclusive: range.endDateExclusive,
      };

      const [
        tenants,
        wallets,
        pools,
        totalPlayersRows,
        roundsRows,
        voucherRows,
        orderRows,
        cashflowRows,
      ] = await Promise.all([
        Tenant.findAll({
          attributes: ["id", "externalId", "name", "status"],
          order: [["name", "ASC"]],
        }),
        TenantWallet.findAll({
          attributes: ["tenantId", "balanceCents"],
        }),
        TenantVoucherPool.findAll({
          attributes: ["tenantId", "poolBalanceCents"],
        }),
        sequelize.query(
          `
            SELECT tenant_id AS "tenantId", COUNT(*)::bigint AS "playersTotal"
            FROM users
            GROUP BY tenant_id
          `,
          { type: QueryTypes.SELECT }
        ),
        sequelize.query(
          `
            SELECT
              tenant_id AS "tenantId",
              COUNT(*)::bigint AS "roundsCount",
              COUNT(DISTINCT "playerId")::bigint AS "activePlayers",
              ROUND(COALESCE(SUM("betAmount"), 0) * 100)::bigint AS "wageredCents",
              ROUND(COALESCE(SUM("winAmount"), 0) * 100)::bigint AS "wonCents"
            FROM game_rounds
            WHERE "createdAt" >= :startDate
              AND "createdAt" < :endDateExclusive
            GROUP BY tenant_id
          `,
          { replacements, type: QueryTypes.SELECT }
        ),
        sequelize.query(
          `
            SELECT
              tenant_id AS "tenantId",
              SUM(CASE WHEN "createdAt" >= :startDate AND "createdAt" < :endDateExclusive THEN 1 ELSE 0 END)::bigint AS "issuedInRange",
              SUM(CASE WHEN "redeemedAt" >= :startDate AND "redeemedAt" < :endDateExclusive THEN 1 ELSE 0 END)::bigint AS "redeemedInRange",
              SUM(CASE WHEN status IN ('new', 'redeemed') THEN 1 ELSE 0 END)::bigint AS "activeVoucherCount"
            FROM vouchers
            GROUP BY tenant_id
          `,
          { replacements, type: QueryTypes.SELECT }
        ),
        sequelize.query(
          `
            SELECT
              tenant_id AS "tenantId",
              COUNT(*)::bigint AS "ordersTotal",
              SUM(CASE WHEN "createdAt" >= :startDate AND "createdAt" < :endDateExclusive THEN 1 ELSE 0 END)::bigint AS "ordersInRange",
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)::bigint AS "ordersPending",
              SUM(CASE WHEN status IN ('completed', 'acknowledged') THEN 1 ELSE 0 END)::bigint AS "ordersCompleted",
              ROUND(COALESCE(SUM(CASE WHEN "createdAt" >= :startDate AND "createdAt" < :endDateExclusive THEN "funAmount" ELSE 0 END), 0) * 100)::bigint AS "requestedFunCentsInRange",
              COALESCE(SUM(CASE WHEN "createdAt" >= :startDate AND "createdAt" < :endDateExclusive THEN COALESCE("credited_amount_cents", 0) ELSE 0 END), 0)::bigint AS "creditedFunCentsInRange",
              MAX("createdAt") AS "lastOrderAt"
            FROM purchase_orders
            GROUP BY tenant_id
          `,
          { replacements, type: QueryTypes.SELECT }
        ),
        sequelize.query(
          `
            SELECT
              tenant_id AS "tenantId",
              ROUND(
                SUM(
                  CASE
                    WHEN type IN ('credit', 'voucher_credit') THEN ABS(COALESCE(amount, 0))
                    WHEN type = 'manual_adjustment' AND COALESCE(amount, 0) > 0 THEN ABS(COALESCE(amount, 0))
                    ELSE 0
                  END
                ) * 100
              )::bigint AS "depositsCents",
              ROUND(
                SUM(
                  CASE
                    WHEN type IN ('debit', 'voucher_debit') THEN ABS(COALESCE(amount, 0))
                    WHEN type = 'manual_adjustment' AND COALESCE(amount, 0) < 0 THEN ABS(COALESCE(amount, 0))
                    ELSE 0
                  END
                ) * 100
              )::bigint AS "withdrawalsCents"
            FROM transactions
            WHERE "createdAt" >= :startDate
              AND "createdAt" < :endDateExclusive
            GROUP BY tenant_id
          `,
          { replacements, type: QueryTypes.SELECT }
        ),
      ]);

      const walletByTenant = new Map(
        wallets.map((row) => [String(row.tenantId), toNumeric(row.balanceCents)])
      );
      const poolByTenant = new Map(
        pools.map((row) => [String(row.tenantId), toNumeric(row.poolBalanceCents)])
      );
      const totalPlayersByTenant = indexByTenant(totalPlayersRows);
      const roundsByTenant = indexByTenant(roundsRows);
      const vouchersByTenant = indexByTenant(voucherRows);
      const ordersByTenant = indexByTenant(orderRows);
      const cashByTenant = indexByTenant(cashflowRows);

      const tenantRows = tenants.map((tenant) => {
        const tenantId = String(tenant.id);
        const totalPlayers = totalPlayersByTenant.get(tenantId) || {};
        const rounds = roundsByTenant.get(tenantId) || {};
        const vouchers = vouchersByTenant.get(tenantId) || {};
        const orders = ordersByTenant.get(tenantId) || {};
        const cash = cashByTenant.get(tenantId) || {};

        const wageredCents = toNumeric(rounds.wageredCents);
        const wonCents = toNumeric(rounds.wonCents);
        const ngrCents = wageredCents - wonCents;
        const depositsCents = toNumeric(cash.depositsCents);
        const withdrawalsCents = toNumeric(cash.withdrawalsCents);

        return {
          tenantId,
          tenantExternalId: tenant.externalId || tenantId,
          tenantName: tenant.name,
          status: tenant.status,
          playersTotal: toNumeric(totalPlayers.playersTotal),
          activePlayers: toNumeric(rounds.activePlayers),
          roundsCount: toNumeric(rounds.roundsCount),
          vouchersIssuedInRange: toNumeric(vouchers.issuedInRange),
          vouchersRedeemedInRange: toNumeric(vouchers.redeemedInRange),
          activeVoucherCount: toNumeric(vouchers.activeVoucherCount),
          walletBalanceCents: toNumeric(walletByTenant.get(tenantId)),
          poolBalanceCents: toNumeric(poolByTenant.get(tenantId)),
          wageredCents,
          wonCents,
          ngrCents,
          depositsCents,
          withdrawalsCents,
          ordersTotal: toNumeric(orders.ordersTotal),
          ordersInRange: toNumeric(orders.ordersInRange),
          ordersPending: toNumeric(orders.ordersPending),
          ordersCompleted: toNumeric(orders.ordersCompleted),
          requestedFunCentsInRange: toNumeric(orders.requestedFunCentsInRange),
          creditedFunCentsInRange: toNumeric(orders.creditedFunCentsInRange),
          lastOrderAt: orders.lastOrderAt || null,
          money: {
            walletFun: toMoney(walletByTenant.get(tenantId)),
            poolFun: toMoney(poolByTenant.get(tenantId)),
            wageredFun: toMoney(wageredCents),
            wonFun: toMoney(wonCents),
            ngrFun: toMoney(ngrCents),
            depositsFun: toMoney(depositsCents),
            withdrawalsFun: toMoney(withdrawalsCents),
            requestedFunInRange: toMoney(orders.requestedFunCentsInRange),
            creditedFunInRange: toMoney(orders.creditedFunCentsInRange),
          },
        };
      });

      tenantRows.sort((a, b) => b.ngrCents - a.ngrCents);

      const charts = {
        ngrByTenant: tenantRows.map((row) => ({
          tenantId: row.tenantId,
          tenantExternalId: row.tenantExternalId,
          tenantName: row.tenantName,
          ngrCents: row.ngrCents,
          ngrFun: row.money.ngrFun,
        })),
        ordersByTenant: tenantRows.map((row) => ({
          tenantId: row.tenantId,
          tenantExternalId: row.tenantExternalId,
          tenantName: row.tenantName,
          ordersInRange: row.ordersInRange,
          ordersCompleted: row.ordersCompleted,
        })),
        walletByTenant: tenantRows.map((row) => ({
          tenantId: row.tenantId,
          tenantExternalId: row.tenantExternalId,
          tenantName: row.tenantName,
          walletBalanceCents: row.walletBalanceCents,
          walletFun: row.money.walletFun,
        })),
      };

      return res.json({
        ok: true,
        range: {
          from: range.from,
          to: range.to,
          days: range.days,
        },
        tenants: tenantRows,
        charts,
      });
    } catch (err) {
      console.error("[OWNER] tenant analytics summary error:", err);
      return res.status(500).json({ ok: false, error: "Failed to load tenant analytics summary" });
    }
  }
);

router.get(
  "/analytics/tenants/:tenantId",
  staffAuth,
  requireOwner,
  async (req, res) => {
    try {
      const { tenantIdentifier, tenantId, tenant } = await resolveTenantFromAnyId(req.params.tenantId);
      if (!tenantIdentifier) {
        return res.status(400).json({ ok: false, error: "tenantId is required" });
      }
      if (!tenant) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      const range = parseOwnerAnalyticsRange(req.query || {});
      const replacements = {
        tenantId,
        startDate: range.startDate,
        endDateExclusive: range.endDateExclusive,
      };
      const orderLimitRaw = Number.parseInt(String(req.query.orderLimit || "200"), 10);
      const orderLimit = Number.isFinite(orderLimitRaw)
        ? Math.min(Math.max(orderLimitRaw, 20), 500)
        : 200;

      const [
        wallet,
        pool,
        playersRow,
        roundsRow,
        vouchersRow,
        ordersRow,
        cashRow,
        dailyRevenueRows,
        dailyOrdersRows,
        dailyCashRows,
        topGamesRows,
        actionRows,
        orderHistoryRows,
      ] = await Promise.all([
        TenantWallet.findOne({ where: { tenantId }, attributes: ["tenantId", "balanceCents"] }),
        TenantVoucherPool.findOne({ where: { tenantId }, attributes: ["tenantId", "poolBalanceCents"] }),
        sequelize.query(
          `
            SELECT COUNT(*)::bigint AS "playersTotal"
            FROM users
            WHERE tenant_id = :tenantId
          `,
          { replacements, type: QueryTypes.SELECT }
        ),
        sequelize.query(
          `
            SELECT
              COUNT(*)::bigint AS "roundsCount",
              COUNT(DISTINCT "playerId")::bigint AS "activePlayers",
              ROUND(COALESCE(SUM("betAmount"), 0) * 100)::bigint AS "wageredCents",
              ROUND(COALESCE(SUM("winAmount"), 0) * 100)::bigint AS "wonCents"
            FROM game_rounds
            WHERE tenant_id = :tenantId
              AND "createdAt" >= :startDate
              AND "createdAt" < :endDateExclusive
          `,
          { replacements, type: QueryTypes.SELECT }
        ),
        sequelize.query(
          `
            SELECT
              SUM(CASE WHEN "createdAt" >= :startDate AND "createdAt" < :endDateExclusive THEN 1 ELSE 0 END)::bigint AS "issuedInRange",
              SUM(CASE WHEN "redeemedAt" >= :startDate AND "redeemedAt" < :endDateExclusive THEN 1 ELSE 0 END)::bigint AS "redeemedInRange",
              SUM(CASE WHEN status IN ('new', 'redeemed') THEN 1 ELSE 0 END)::bigint AS "activeVoucherCount"
            FROM vouchers
            WHERE tenant_id = :tenantId
          `,
          { replacements, type: QueryTypes.SELECT }
        ),
        sequelize.query(
          `
            SELECT
              COUNT(*)::bigint AS "ordersTotal",
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)::bigint AS "ordersPending",
              SUM(CASE WHEN status IN ('completed', 'acknowledged') THEN 1 ELSE 0 END)::bigint AS "ordersCompleted",
              ROUND(COALESCE(SUM(CASE WHEN "createdAt" >= :startDate AND "createdAt" < :endDateExclusive THEN "funAmount" ELSE 0 END), 0) * 100)::bigint AS "requestedFunCentsInRange",
              COALESCE(SUM(CASE WHEN "createdAt" >= :startDate AND "createdAt" < :endDateExclusive THEN COALESCE("credited_amount_cents", 0) ELSE 0 END), 0)::bigint AS "creditedFunCentsInRange"
            FROM purchase_orders
            WHERE tenant_id = :tenantId
          `,
          { replacements, type: QueryTypes.SELECT }
        ),
        sequelize.query(
          `
            SELECT
              ROUND(
                SUM(
                  CASE
                    WHEN type IN ('credit', 'voucher_credit') THEN ABS(COALESCE(amount, 0))
                    WHEN type = 'manual_adjustment' AND COALESCE(amount, 0) > 0 THEN ABS(COALESCE(amount, 0))
                    ELSE 0
                  END
                ) * 100
              )::bigint AS "depositsCents",
              ROUND(
                SUM(
                  CASE
                    WHEN type IN ('debit', 'voucher_debit') THEN ABS(COALESCE(amount, 0))
                    WHEN type = 'manual_adjustment' AND COALESCE(amount, 0) < 0 THEN ABS(COALESCE(amount, 0))
                    ELSE 0
                  END
                ) * 100
              )::bigint AS "withdrawalsCents"
            FROM transactions
            WHERE tenant_id = :tenantId
              AND "createdAt" >= :startDate
              AND "createdAt" < :endDateExclusive
          `,
          { replacements, type: QueryTypes.SELECT }
        ),
        sequelize.query(
          `
            SELECT
              DATE_TRUNC('day', "createdAt") AS "day",
              COUNT(*)::bigint AS "roundsCount",
              ROUND(COALESCE(SUM("betAmount"), 0) * 100)::bigint AS "wageredCents",
              ROUND(COALESCE(SUM("winAmount"), 0) * 100)::bigint AS "wonCents"
            FROM game_rounds
            WHERE tenant_id = :tenantId
              AND "createdAt" >= :startDate
              AND "createdAt" < :endDateExclusive
            GROUP BY "day"
            ORDER BY "day" ASC
          `,
          { replacements, type: QueryTypes.SELECT }
        ),
        sequelize.query(
          `
            SELECT
              DATE_TRUNC('day', "createdAt") AS "day",
              COUNT(*)::bigint AS "ordersCount",
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)::bigint AS "pendingCount",
              SUM(CASE WHEN status IN ('completed', 'acknowledged') THEN 1 ELSE 0 END)::bigint AS "completedCount",
              ROUND(COALESCE(SUM("funAmount"), 0) * 100)::bigint AS "requestedFunCents",
              COALESCE(SUM(COALESCE("credited_amount_cents", 0)), 0)::bigint AS "creditedFunCents"
            FROM purchase_orders
            WHERE tenant_id = :tenantId
              AND "createdAt" >= :startDate
              AND "createdAt" < :endDateExclusive
            GROUP BY "day"
            ORDER BY "day" ASC
          `,
          { replacements, type: QueryTypes.SELECT }
        ),
        sequelize.query(
          `
            SELECT
              DATE_TRUNC('day', "createdAt") AS "day",
              ROUND(
                SUM(
                  CASE
                    WHEN type IN ('credit', 'voucher_credit') THEN ABS(COALESCE(amount, 0))
                    WHEN type = 'manual_adjustment' AND COALESCE(amount, 0) > 0 THEN ABS(COALESCE(amount, 0))
                    ELSE 0
                  END
                ) * 100
              )::bigint AS "depositsCents",
              ROUND(
                SUM(
                  CASE
                    WHEN type IN ('debit', 'voucher_debit') THEN ABS(COALESCE(amount, 0))
                    WHEN type = 'manual_adjustment' AND COALESCE(amount, 0) < 0 THEN ABS(COALESCE(amount, 0))
                    ELSE 0
                  END
                ) * 100
              )::bigint AS "withdrawalsCents"
            FROM transactions
            WHERE tenant_id = :tenantId
              AND "createdAt" >= :startDate
              AND "createdAt" < :endDateExclusive
            GROUP BY "day"
            ORDER BY "day" ASC
          `,
          { replacements, type: QueryTypes.SELECT }
        ),
        sequelize.query(
          `
            SELECT
              "gameId" AS "gameId",
              COUNT(*)::bigint AS "roundsCount",
              ROUND(COALESCE(SUM("betAmount"), 0) * 100)::bigint AS "wageredCents",
              ROUND(COALESCE(SUM("winAmount"), 0) * 100)::bigint AS "wonCents"
            FROM game_rounds
            WHERE tenant_id = :tenantId
              AND "createdAt" >= :startDate
              AND "createdAt" < :endDateExclusive
            GROUP BY "gameId"
            ORDER BY "roundsCount" DESC
            LIMIT 15
          `,
          { replacements, type: QueryTypes.SELECT }
        ),
        sequelize.query(
          `
            SELECT
              action_type AS "actionType",
              COUNT(*)::bigint AS "entriesCount",
              COALESCE(SUM(amount_cents), 0)::bigint AS "totalCents"
            FROM credit_ledger
            WHERE tenant_id = :tenantId
              AND "createdAt" >= :startDate
              AND "createdAt" < :endDateExclusive
            GROUP BY action_type
            ORDER BY ABS(COALESCE(SUM(amount_cents), 0)) DESC
          `,
          { replacements, type: QueryTypes.SELECT }
        ),
        PurchaseOrder.findAll({
          where: { tenantId },
          order: [["createdAt", "DESC"]],
          limit: orderLimit,
        }),
      ]);

      const players = playersRow?.[0] || {};
      const rounds = roundsRow?.[0] || {};
      const vouchers = vouchersRow?.[0] || {};
      const orders = ordersRow?.[0] || {};
      const cash = cashRow?.[0] || {};

      const days = buildDayBuckets(range.startDate, range.endDateExclusive);

      const revenueByDay = new Map();
      for (const row of dailyRevenueRows || []) {
        const key = dayKey(row.day);
        if (!key) continue;
        revenueByDay.set(key, row);
      }
      const ordersByDay = new Map();
      for (const row of dailyOrdersRows || []) {
        const key = dayKey(row.day);
        if (!key) continue;
        ordersByDay.set(key, row);
      }
      const cashByDay = new Map();
      for (const row of dailyCashRows || []) {
        const key = dayKey(row.day);
        if (!key) continue;
        cashByDay.set(key, row);
      }

      const dailyRevenue = days.map((day) => {
        const row = revenueByDay.get(day) || {};
        const wageredCents = toNumeric(row.wageredCents);
        const wonCents = toNumeric(row.wonCents);
        const ngrCents = wageredCents - wonCents;
        return {
          day,
          roundsCount: toNumeric(row.roundsCount),
          wageredCents,
          wonCents,
          ngrCents,
          wageredFun: toMoney(wageredCents),
          wonFun: toMoney(wonCents),
          ngrFun: toMoney(ngrCents),
        };
      });

      const dailyOrders = days.map((day) => {
        const row = ordersByDay.get(day) || {};
        const requestedFunCents = toNumeric(row.requestedFunCents);
        const creditedFunCents = toNumeric(row.creditedFunCents);
        return {
          day,
          ordersCount: toNumeric(row.ordersCount),
          pendingCount: toNumeric(row.pendingCount),
          completedCount: toNumeric(row.completedCount),
          requestedFunCents,
          creditedFunCents,
          requestedFun: toMoney(requestedFunCents),
          creditedFun: toMoney(creditedFunCents),
        };
      });

      const dailyCashflow = days.map((day) => {
        const row = cashByDay.get(day) || {};
        const depositsCents = toNumeric(row.depositsCents);
        const withdrawalsCents = toNumeric(row.withdrawalsCents);
        const netCents = depositsCents - withdrawalsCents;
        return {
          day,
          depositsCents,
          withdrawalsCents,
          netCents,
          depositsFun: toMoney(depositsCents),
          withdrawalsFun: toMoney(withdrawalsCents),
          netFun: toMoney(netCents),
        };
      });

      const topGames = (topGamesRows || []).map((row) => {
        const wageredCents = toNumeric(row.wageredCents);
        const wonCents = toNumeric(row.wonCents);
        const ngrCents = wageredCents - wonCents;
        return {
          gameId: row.gameId || "unknown",
          roundsCount: toNumeric(row.roundsCount),
          wageredCents,
          wonCents,
          ngrCents,
          wageredFun: toMoney(wageredCents),
          wonFun: toMoney(wonCents),
          ngrFun: toMoney(ngrCents),
        };
      });

      const actionBreakdown = (actionRows || []).map((row) => ({
        actionType: row.actionType || "unknown",
        entriesCount: toNumeric(row.entriesCount),
        totalCents: toNumeric(row.totalCents),
        totalFun: toMoney(row.totalCents),
      }));

      const orderHistory = (orderHistoryRows || []).map((order) => ({
        id: order.id,
        status: order.status,
        requestedBy: order.requestedBy,
        requestedById: order.requestedById,
        funAmount: toNumeric(order.funAmount),
        btcAmount: toNumeric(order.btcAmount),
        btcRate: toNumeric(order.btcRate, null),
        ownerBtcAddress: order.ownerBtcAddress || null,
        paymentWalletProvider: order.paymentWalletProvider || null,
        confirmationCode: order.confirmationCode || null,
        receiptCode: order.receiptCode || null,
        creditedAmountCents: toNumeric(order.creditedAmountCents),
        creditedAmountFun: toMoney(order.creditedAmountCents),
        ownerApprovedAt: order.ownerApprovedAt || null,
        paymentConfirmedAt: order.paymentConfirmedAt || null,
        ownerCreditedAt: order.ownerCreditedAt || null,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
      }));

      const wageredCents = toNumeric(rounds.wageredCents);
      const wonCents = toNumeric(rounds.wonCents);
      const ngrCents = wageredCents - wonCents;
      const depositsCents = toNumeric(cash.depositsCents);
      const withdrawalsCents = toNumeric(cash.withdrawalsCents);
      const requestedFunCentsInRange = toNumeric(orders.requestedFunCentsInRange);
      const creditedFunCentsInRange = toNumeric(orders.creditedFunCentsInRange);

      return res.json({
        ok: true,
        tenant: tenant.toJSON(),
        range: {
          from: range.from,
          to: range.to,
          days: range.days,
        },
        kpis: {
          playersTotal: toNumeric(players.playersTotal),
          activePlayers: toNumeric(rounds.activePlayers),
          roundsCount: toNumeric(rounds.roundsCount),
          vouchersIssuedInRange: toNumeric(vouchers.issuedInRange),
          vouchersRedeemedInRange: toNumeric(vouchers.redeemedInRange),
          activeVoucherCount: toNumeric(vouchers.activeVoucherCount),
          walletBalanceCents: toNumeric(wallet?.balanceCents),
          poolBalanceCents: toNumeric(pool?.poolBalanceCents),
          wageredCents,
          wonCents,
          ngrCents,
          depositsCents,
          withdrawalsCents,
          netCashflowCents: depositsCents - withdrawalsCents,
          ordersTotal: toNumeric(orders.ordersTotal),
          ordersPending: toNumeric(orders.ordersPending),
          ordersCompleted: toNumeric(orders.ordersCompleted),
          requestedFunCentsInRange,
          creditedFunCentsInRange,
          money: {
            walletFun: toMoney(wallet?.balanceCents),
            poolFun: toMoney(pool?.poolBalanceCents),
            wageredFun: toMoney(wageredCents),
            wonFun: toMoney(wonCents),
            ngrFun: toMoney(ngrCents),
            depositsFun: toMoney(depositsCents),
            withdrawalsFun: toMoney(withdrawalsCents),
            netCashflowFun: toMoney(depositsCents - withdrawalsCents),
            requestedFunInRange: toMoney(requestedFunCentsInRange),
            creditedFunInRange: toMoney(creditedFunCentsInRange),
          },
        },
        series: {
          dailyRevenue,
          dailyOrders,
          dailyCashflow,
        },
        datasets: {
          topGames,
          actionBreakdown,
          orderHistory,
        },
      });
    } catch (err) {
      console.error("[OWNER] tenant analytics detail error:", err);
      return res.status(500).json({ ok: false, error: "Failed to load tenant analytics detail" });
    }
  }
);

router.post(
  "/tenants",
  staffAuth,
  requireOwner,
  async (req, res) => {
    const name = String(req.body?.name || "").trim();
    const status = String(req.body?.status || "active").trim() || "active";
    const requestedTenantIdentifier = normalizeTenantIdentifier(
      req.body?.tenantId || req.body?.id || req.body?.externalId || req.body?.externalTenantId
    );

    const seedCreditsCents = clampCents(req.body?.seedCreditsCents || req.body?.initialCreditsCents || 0);
    const seedVoucherPoolCents = clampCents(req.body?.seedVoucherPoolCents || req.body?.initialVoucherPoolCents || 0);

    const admin = req.body?.admin || req.body?.bootstrapAdmin || {};
    const requestedUsername = admin?.username || "";
    const requestedEmail = admin?.email || null;
    const requestedPassword = admin?.password || "";

    const tenantConfig = req.body?.tenantConfig || null;

    if (!name) {
      return res.status(400).json({ ok: false, error: "Tenant name is required" });
    }

    try {
      const result = await withRequestTransaction(req, async (t) => {
        if (requestedTenantIdentifier) {
          const identifierTaken = await isTenantIdentifierTaken(requestedTenantIdentifier, {
            transaction: t,
            lock: t.LOCK.UPDATE,
          });
          if (identifierTaken) {
            const conflict = new Error(`Tenant identifier already exists: ${requestedTenantIdentifier}`);
            conflict.status = 409;
            throw conflict;
          }
        }

        const tenantInternalId =
          requestedTenantIdentifier && isUuidLike(requestedTenantIdentifier)
            ? requestedTenantIdentifier
            : crypto.randomUUID();
        const tenantExternalId = requestedTenantIdentifier || tenantInternalId;

        // 1) create tenant
        const tenant = await Tenant.create(
          {
            id: tenantInternalId,
            externalId: tenantExternalId,
            name,
            status,
            distributorId: null,
          },
          { transaction: t }
        );

        // 2) create distributor record (same thing) using SAME ID
        const distributor = await Distributor.create(
          {
            id: tenant.id,
            name: name,
            status,
          },
          { transaction: t }
        );

        // 3) link tenant -> distributor (same id)
        tenant.distributorId = distributor.id;
        await tenant.save({ transaction: t });

        // 4) create tenant wallets
        const totalIssued = seedCreditsCents + seedVoucherPoolCents;
        const wallet = await TenantWallet.create(
          {
            tenantId: tenant.id,
            balanceCents: totalIssued,
            currency: "FUN",
          },
          { transaction: t }
        );

        const pool = await TenantVoucherPool.create(
          {
            tenantId: tenant.id,
            poolBalanceCents: seedVoucherPoolCents,
            currency: "FUN",
          },
          { transaction: t }
        );

        if (totalIssued > 0) {
          await CreditLedger.create(
            {
              tenantId: tenant.id,
              actorUserId: req.staff?.id || null,
              actionType: "issue_credits",
              amountCents: totalIssued,
              memo: "bootstrap",
            },
            { transaction: t }
          );
        }

        if (seedVoucherPoolCents > 0) {
          await CreditLedger.create(
            {
              tenantId: tenant.id,
              actorUserId: req.staff?.id || null,
              actionType: "allocate_voucher_pool",
              amountCents: seedVoucherPoolCents,
              memo: "bootstrap",
            },
            { transaction: t }
          );
          // Move funds from wallet into pool (wallet holds only seedCredits after bootstrap)
          wallet.balanceCents = Number(wallet.balanceCents || 0) - seedVoucherPoolCents;
          await wallet.save({ transaction: t });
        }

        // 5) bootstrap distributor/admin staff login
        const usernameBase = requestedUsername || `${slugify(name) || "tenant"}-admin`;
        const username = await ensureUniqueUsername({ tenantId: tenant.id, desired: usernameBase }, t);
        const password = requestedPassword || randomPassword(16);
        const passwordHash = await bcrypt.hash(password, 12);

        const rootStaff = await StaffUser.create(
          {
            tenantId: tenant.id,
            distributorId: distributor.id,
            username,
            email: requestedEmail,
            passwordHash,
            role: "distributor",
            permissions: ROLE_DEFAULT_PERMISSIONS[ROLES.DISTRIBUTOR] || [],
            isActive: true,
          },
          { transaction: t }
        );

        await OwnerSetting.upsert(
          {
            key: rootStaffKey(tenant.id),
            value: String(rootStaff.id),
          },
          { transaction: t }
        );

        // 6) optional per-tenant config seed
        if (tenantConfig && typeof tenantConfig === "object") {
          await OwnerSetting.upsert(
            {
              key: tenantConfigKey(tenant.id),
              value: JSON.stringify(tenantConfig),
            },
            { transaction: t }
          );
        }

        const adminUiUrl = buildTenantLoginUrl(tenant);

        return {
          tenant: tenant.toJSON(),
          distributor: distributor.toJSON(),
          wallet: wallet.toJSON(),
          pool: pool.toJSON(),
          bootstrap: {
            username,
            password,
            adminUiUrl,
          },
        };
      });

      await tryAuditLog({
        tenantId: result.tenant?.id || null,
        actorType: "owner",
        actorId: null,
        action: "tenant.create",
        entityType: "tenant",
        entityId: result.tenant?.id || null,
        before: null,
        after: {
          tenant: {
            id: result.tenant?.id || null,
            name: result.tenant?.name || null,
            status: result.tenant?.status || null,
          },
          distributor: {
            id: result.distributor?.id || null,
            status: result.distributor?.status || null,
          },
        },
        requestId: req.requestId || null,
      });

      return res.status(201).json({ ok: true, ...result });
    } catch (err) {
      console.error("[OWNER] tenant create error:", err);
      if (err?.status) {
        return res.status(err.status).json({ ok: false, error: err.message || "Tenant creation failed" });
      }
      if (
        requestedTenantIdentifier &&
        (err?.name === "SequelizeUniqueConstraintError" || err?.name === "SequelizeDatabaseError")
      ) {
        return res.status(409).json({ ok: false, error: `Tenant identifier already exists: ${requestedTenantIdentifier}` });
      }
      return res.status(500).json({ ok: false, error: "Failed to create tenant" });
    }
  }
);

// Per-tenant config
async function handleGetTenantConfig(req, res) {
  try {
    const { tenantIdentifier, tenantId, tenant } = await resolveTenantFromAnyId(
      req.params.tenantId || req.params.id
    );
    if (!tenantIdentifier) {
      return res.status(400).json({ ok: false, error: "tenantId is required" });
    }
    if (!tenant || !tenantId) {
      return res.status(404).json({ ok: false, error: "Tenant not found" });
    }
    const system = await getSystemConfig();
    const tenantCfgRaw = await getJson(tenantConfigKey(tenantId), {});
    const tenantCfg = { ...(tenantCfgRaw || {}) };
    if (Object.prototype.hasOwnProperty.call(tenantCfg, "outcomeMode")) {
      tenantCfg.outcomeMode = normalizeOutcomeMode(tenantCfg.outcomeMode, system.outcomeMode);
    }
    if (Object.prototype.hasOwnProperty.call(tenantCfg, "voucherWinCapPolicy")) {
      tenantCfg.voucherWinCapPolicy = normalizeVoucherWinCapPolicy(tenantCfg.voucherWinCapPolicy);
    }
    const effective = { ...system, ...tenantCfg };
    effective.outcomeMode = normalizeOutcomeMode(effective.outcomeMode, system.outcomeMode);
    effective.voucherWinCapPolicy = normalizeVoucherWinCapPolicy(effective.voucherWinCapPolicy);
    res.json({ ok: true, system, tenant: tenantCfg, effective });
  } catch (err) {
    console.error("[OWNER] tenant config get error:", err);
    res.status(500).json({ ok: false, error: "Failed to load tenant config" });
  }
}

async function handleSetTenantConfig(req, res) {
  try {
    const { tenantIdentifier, tenantId, tenant } = await resolveTenantFromAnyId(
      req.params.tenantId || req.params.id
    );
    if (!tenantIdentifier) {
      return res.status(400).json({ ok: false, error: "tenantId is required" });
    }
    if (!tenant || !tenantId) {
      return res.status(404).json({ ok: false, error: "Tenant not found" });
    }
    const patch = req.body?.config;
    if (!patch || typeof patch !== "object") {
      return res.status(400).json({ ok: false, error: "config must be an object" });
    }
    const current = await getJson(tenantConfigKey(tenantId), {});
    const merged = { ...(current || {}), ...patch };
    if (Object.prototype.hasOwnProperty.call(patch, "outcomeMode")) {
      merged.outcomeMode = normalizeOutcomeMode(
        patch.outcomeMode,
        normalizeOutcomeMode(current?.outcomeMode, DEFAULT_OUTCOME_MODE)
      );
    }
    if (Object.prototype.hasOwnProperty.call(patch, "voucherWinCapPolicy")) {
      merged.voucherWinCapPolicy = normalizeVoucherWinCapPolicy(patch.voucherWinCapPolicy);
    }
    await setJson(tenantConfigKey(tenantId), merged);
    const system = await getSystemConfig();
    const effective = {
      ...system,
      ...merged,
      outcomeMode: normalizeOutcomeMode(merged.outcomeMode, system.outcomeMode),
    };
    effective.voucherWinCapPolicy = normalizeVoucherWinCapPolicy(effective.voucherWinCapPolicy);
    res.json({ ok: true, tenant: merged, system, effective });
  } catch (err) {
    console.error("[OWNER] tenant config set error:", err);
    res.status(500).json({ ok: false, error: "Failed to save tenant config" });
  }
}

router.get("/tenants/:tenantId/config", staffAuth, requireOwner, handleGetTenantConfig);
router.get("/tenants/:id/config", staffAuth, requireOwner, handleGetTenantConfig);
router.post("/tenants/:tenantId/config", staffAuth, requireOwner, handleSetTenantConfig);
router.put("/tenants/:tenantId/config", staffAuth, requireOwner, handleSetTenantConfig);
router.put("/tenants/:id/config", staffAuth, requireOwner, handleSetTenantConfig);

// Reset the tenant bootstrap admin password (returns the new password one-time)
async function handleResetAdminPassword(req, res) {
  try {
    const { tenantIdentifier, tenantId, tenant } = await resolveTenantFromAnyId(
      req.params.tenantId || req.params.id
    );
    if (!tenantIdentifier) {
      return res.status(400).json({ ok: false, error: "tenantId is required" });
    }
    if (!tenant || !tenantId) {
      return res.status(404).json({ ok: false, error: "Tenant not found" });
    }
    let staffId = await getSetting(rootStaffKey(tenantId));

    let staff = null;
    if (staffId) {
      const idNum = Number(staffId);
      if (Number.isFinite(idNum)) {
        staff = await StaffUser.findByPk(idNum);
      }
    }

    if (!staff) {
      // best-effort fallback: oldest distributor user for the tenant
      staff = await StaffUser.findOne({
        where: { tenantId, role: "distributor" },
        order: [["createdAt", "ASC"]],
      });
    }

    if (!staff) {
      return res.status(404).json({ ok: false, error: "Bootstrap admin not found" });
    }

    const password = randomPassword(16);
    staff.passwordHash = await bcrypt.hash(password, 12);
    await staff.save();

    await OwnerSetting.upsert({
      key: rootStaffKey(tenantId),
      value: String(staff.id),
    });

    const adminUiUrl = buildTenantLoginUrl(tenant);

    await tryAuditLog({
      tenantId,
      actorType: "owner",
      actorId: null,
      action: "tenant.reset_admin_password",
      entityType: "staff",
      entityId: null,
      before: { staffId: staff.id, username: staff.username },
      after: { staffId: staff.id, username: staff.username, reset: true },
      requestId: req.requestId || null,
    });

    res.json({ ok: true, username: staff.username, password, adminUiUrl });
  } catch (err) {
    console.error("[OWNER] bootstrap reset error:", err);
    res.status(500).json({ ok: false, error: "Failed to reset password" });
  }
}

router.post("/tenants/:tenantId/bootstrap/reset-password", staffAuth, requireOwner, handleResetAdminPassword);
router.post("/tenants/:id/reset-admin-password", staffAuth, requireOwner, handleResetAdminPassword);

// Issue credits directly to tenant wallet (owner only)
router.post(
  "/tenants/:tenantId/credits",
  staffAuth,
  requireOwner,
  async (req, res) => {
    try {
      const { tenantIdentifier, tenantId } = await resolveTenantFromAnyId(req.params.tenantId);
      if (!tenantIdentifier) {
        return res.status(400).json({ ok: false, error: "tenantId is required" });
      }
      if (!tenantId) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }
      const amountCents = clampCents(req.body?.amountCents);
      const memo = (req.body?.memo || "").trim() || null;

      if (!amountCents || amountCents <= 0) {
        return res.status(400).json({ ok: false, error: "amountCents must be > 0" });
      }

      const result = await withRequestTransaction(req, async (t) => {
        let wallet = await TenantWallet.findOne({
          where: { tenantId },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        if (!wallet) {
          wallet = await TenantWallet.create(
            { tenantId, balanceCents: 0, currency: "FUN" },
            { transaction: t }
          );
        }

        const beforeBalance = Number(wallet.balanceCents || 0);
        wallet.balanceCents = beforeBalance + amountCents;
        await wallet.save({ transaction: t });

        await CreditLedger.create(
          {
            tenantId,
            actorUserId: req.staff?.id || null,
            actionType: "issue_credits",
            amountCents,
            memo,
          },
          { transaction: t }
        );

        return { wallet, beforeBalance };
      });

      await tryAuditLog({
        tenantId,
        actorType: "owner",
        actorId: null,
        action: "tenant.issue_credits",
        entityType: "tenant_wallet",
        entityId: null,
        before: { balanceCents: result.beforeBalance },
        after: { balanceCents: result.wallet.balanceCents, amountCents },
        requestId: req.requestId || null,
      });

      res.json({ ok: true, wallet: result.wallet });
    } catch (err) {
      console.error("[OWNER] issue credits error:", err);
      res.status(500).json({ ok: false, error: "Failed to issue credits" });
    }
  }
);

// Allocate funds from tenant wallet to voucher pool
router.post(
  "/tenants/:tenantId/voucher-pool",
  staffAuth,
  requireOwner,
  async (req, res) => {
    try {
      const { tenantIdentifier, tenantId } = await resolveTenantFromAnyId(req.params.tenantId);
      if (!tenantIdentifier) {
        return res.status(400).json({ ok: false, error: "tenantId is required" });
      }
      if (!tenantId) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }
      const amountCents = clampCents(req.body?.amountCents);
      const memo = (req.body?.memo || "").trim() || null;

      if (!amountCents || amountCents <= 0) {
        return res.status(400).json({ ok: false, error: "amountCents must be > 0" });
      }

      const result = await withRequestTransaction(req, async (t) => {
        let wallet = await TenantWallet.findOne({
          where: { tenantId },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        if (!wallet) {
          wallet = await TenantWallet.create(
            { tenantId, balanceCents: 0, currency: "FUN" },
            { transaction: t }
          );
        }

        if (Number(wallet.balanceCents || 0) < amountCents) {
          const e = new Error("INSUFFICIENT_TENANT_BALANCE");
          e.status = 400;
          throw e;
        }

        const beforeWalletBalance = Number(wallet.balanceCents || 0);
        let pool = await TenantVoucherPool.findOne({
          where: { tenantId },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        if (!pool) {
          pool = await TenantVoucherPool.create(
            { tenantId, poolBalanceCents: 0, currency: "FUN" },
            { transaction: t }
          );
        }

        const beforePoolBalance = Number(pool.poolBalanceCents || 0);
        wallet.balanceCents = Number(wallet.balanceCents || 0) - amountCents;
        pool.poolBalanceCents = Number(pool.poolBalanceCents || 0) + amountCents;

        await wallet.save({ transaction: t });
        await pool.save({ transaction: t });

        await CreditLedger.create(
          {
            tenantId,
            actorUserId: req.staff?.id || null,
            actionType: "allocate_voucher_pool",
            amountCents,
            memo,
          },
          { transaction: t }
        );

        return { wallet, pool, beforeWalletBalance, beforePoolBalance };
      });

      await tryAuditLog({
        tenantId,
        actorType: "owner",
        actorId: null,
        action: "tenant.allocate_voucher_pool",
        entityType: "tenant_voucher_pool",
        entityId: null,
        before: {
          walletBalanceCents: result.beforeWalletBalance,
          poolBalanceCents: result.beforePoolBalance,
        },
        after: {
          walletBalanceCents: result.wallet.balanceCents,
          poolBalanceCents: result.pool.poolBalanceCents,
          amountCents,
        },
        requestId: req.requestId || null,
      });

      res.json({ ok: true, wallet: result.wallet, pool: result.pool });
    } catch (err) {
      if (err?.message === "INSUFFICIENT_TENANT_BALANCE") {
        return res.status(400).json({ ok: false, error: "Insufficient tenant balance" });
      }
      console.error("[OWNER] allocate voucher pool error:", err);
      res.status(500).json({ ok: false, error: "Failed to allocate voucher pool" });
    }
  }
);

// --------------------
// System reset (owner-only)
// --------------------
router.post("/wipe-all", staffAuth, requireOwner, async (req, res) => {
  try {
    const confirm = String(req.body?.confirm || "").trim();
    if (confirm !== "ERASE ALL") {
      return res.status(400).json({
        ok: false,
        error: "Confirmation phrase mismatch",
        expected: "ERASE ALL",
      });
    }

    const password = String(req.body?.password || "").trim();
    if (!password) {
      return res.status(400).json({ ok: false, error: "Password is required" });
    }

    const staff = await StaffUser.findByPk(req.staff?.id);
    if (!staff) {
      return res.status(403).json({ ok: false, error: "Staff not found" });
    }

    const ok = await bcrypt.compare(password, staff.passwordHash || "");
    if (!ok) {
      return res.status(403).json({ ok: false, error: "Invalid password" });
    }

    await wipeAllData({
      transaction: req.transaction,
      preserveOwners: true,
      preserveOwnerSettings: true,
      resetTenantBalances: true,
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("[OWNER] wipe-all error:", err);
    return res.status(500).json({ ok: false, error: "Failed to wipe data" });
  }
});

// --------------------
// Back-compat: distributors endpoints
// (Tenants and distributors are the same thing in this product.)
// --------------------
router.get(
  "/distributors",
  staffAuth,
  requireOwner,
  async (req, res) => {
    try {
      const tenants = await Tenant.findAll({ order: [["createdAt", "DESC"]] });
      // Present tenants as distributors for older UIs.
      const distributors = tenants.map((t) => ({
        id: t.id,
        externalId: t.externalId || t.id,
        name: t.name,
        status: t.status,
      }));
      res.json({ ok: true, distributors });
    } catch (err) {
      console.error("[OWNER] distributors list error:", err);
      res.status(500).json({ ok: false, error: "Failed to load distributors" });
    }
  }
);

router.post(
  "/distributors",
  staffAuth,
  requireOwner,
  async (req, res) => {
    return res.status(400).json({
      ok: false,
      error: "Distributors are the same as tenants. Use POST /api/v1/owner/tenants instead.",
    });
  }
);


// DELETE /api/v1/owner/tenants/:tenantId
// Hard-delete: removes tenant record and all tenant data.
router.delete(
  "/tenants/:tenantId",
  staffAuth,
  requireOwner,
  async (req, res) => {
    try {
      const { tenantIdentifier, tenantId } = await resolveTenantFromAnyId(req.params.tenantId);
      if (!tenantIdentifier) {
        return res.status(400).json({ ok: false, error: "tenantId required" });
      }
      if (!tenantId) {
        return res.status(404).json({ ok: false, error: "Tenant not found" });
      }

      let beforeStatus = null;
      let distributorId = null;
      await withRequestTransaction(req, async (t) => {
        const tenant = await Tenant.findByPk(tenantId, { transaction: t, lock: t.LOCK.UPDATE });
        if (!tenant) {
          const e = new Error("Tenant not found");
          e.status = 404;
          throw e;
        }

        beforeStatus = tenant.status || null;
        distributorId = tenant.distributorId || null;

        await wipeTenantData(tenantId, {
          transaction: t,
          resetTenantBalances: false,
        });

        await TenantWallet.destroy({ where: { tenantId }, transaction: t });
        await TenantVoucherPool.destroy({ where: { tenantId }, transaction: t });
        await OwnerSetting.destroy({
          where: { key: { [Op.like]: `tenant:${tenantId}:%` } },
          transaction: t,
        });

        await Tenant.destroy({ where: { id: tenantId }, transaction: t });

        if (distributorId) {
          const remaining = await Tenant.count({ where: { distributorId }, transaction: t });
          if (remaining === 0) {
            await Distributor.destroy({ where: { id: distributorId }, transaction: t });
          }
        }
      });

      await tryAuditLog({
        tenantId,
        actorType: "owner",
        actorId: null,
        action: "tenant.delete",
        entityType: "tenant",
        entityId: tenantId,
        before: { status: beforeStatus },
        after: { deleted: true },
        requestId: req.requestId || null,
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error("[OWNER] delete tenant error:", err);
      return res.status(err.status || 500).json({ ok: false, error: err.message || "Failed" });
    }
  }
);

module.exports = router;
