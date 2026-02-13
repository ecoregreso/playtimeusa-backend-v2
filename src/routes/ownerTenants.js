// src/routes/ownerTenants.js
// Owner console routes (global / multi-tenant admin)

const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { Op } = require("sequelize");

const {
  Tenant,
  Distributor,
  TenantWallet,
  TenantVoucherPool,
  CreditLedger,
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
const { wipeAllData, wipeTenantData } = require("../services/wipeService");
const { emitSecurityEvent } = require("../lib/security/events");
const { writeAuditLog } = require("../lib/security/audit");

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
  voucherWinCapPolicy: { ...DEFAULT_VOUCHER_WIN_CAP_POLICY },
};

async function getSystemConfig() {
  const cfg = await getJson(SYSTEM_CONFIG_KEY, null);
  if (!cfg || typeof cfg !== "object") return { ...DEFAULT_SYSTEM_CONFIG };
  const merged = { ...DEFAULT_SYSTEM_CONFIG, ...cfg };
  merged.voucherWinCapPolicy = normalizeVoucherWinCapPolicy(merged.voucherWinCapPolicy);
  return merged;
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

router.post(
  "/tenants",
  staffAuth,
  requireOwner,
  async (req, res) => {
    const name = String(req.body?.name || "").trim();
    const status = String(req.body?.status || "active").trim() || "active";

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
        // 1) create tenant
        const tenant = await Tenant.create(
          {
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

        const base = adminUiBase();
        const adminUiUrl = base ? `${base}/login?tenantId=${tenant.id}` : `/login?tenantId=${tenant.id}`;

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
      return res.status(500).json({ ok: false, error: "Failed to create tenant" });
    }
  }
);

// Per-tenant config
async function handleGetTenantConfig(req, res) {
  try {
    const tenantId = String(req.params.tenantId || req.params.id || "").trim();
    const system = await getSystemConfig();
    const tenantCfg = await getJson(tenantConfigKey(tenantId), {});
    const effective = { ...system, ...(tenantCfg || {}) };
    res.json({ ok: true, system, tenant: tenantCfg || {}, effective });
  } catch (err) {
    console.error("[OWNER] tenant config get error:", err);
    res.status(500).json({ ok: false, error: "Failed to load tenant config" });
  }
}

async function handleSetTenantConfig(req, res) {
  try {
    const tenantId = String(req.params.tenantId || req.params.id || "").trim();
    const patch = req.body?.config;
    if (!patch || typeof patch !== "object") {
      return res.status(400).json({ ok: false, error: "config must be an object" });
    }
    const current = await getJson(tenantConfigKey(tenantId), {});
    const merged = { ...(current || {}), ...patch };
    if (Object.prototype.hasOwnProperty.call(patch, "voucherWinCapPolicy")) {
      merged.voucherWinCapPolicy = normalizeVoucherWinCapPolicy(patch.voucherWinCapPolicy);
    }
    await setJson(tenantConfigKey(tenantId), merged);
    const system = await getSystemConfig();
    const effective = { ...system, ...merged };
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
    const tenantId = String(req.params.tenantId || req.params.id || "").trim();
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

    const base = adminUiBase();
    const adminUiUrl = base ? `${base}/login?tenantId=${tenantId}` : `/login?tenantId=${tenantId}`;

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
      const tenantId = req.params.tenantId;
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
      const tenantId = req.params.tenantId;
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
      const distributors = tenants.map((t) => ({ id: t.id, name: t.name, status: t.status }));
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
      const tenantId = String(req.params.tenantId || "").trim();
      if (!tenantId) {
        return res.status(400).json({ ok: false, error: "tenantId required" });
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
