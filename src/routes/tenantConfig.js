// src/routes/tenantConfig.js
const express = require("express");
const { staffAuth } = require("../middleware/staffAuth");
const { getJson, setJson } = require("../utils/ownerSettings");
const {
  DEFAULT_VOUCHER_WIN_CAP_POLICY,
  normalizeVoucherWinCapPolicy,
  buildVoucherWinCapOptions,
} = require("../services/voucherWinCapPolicyService");

const router = express.Router();

const SYSTEM_CONFIG_KEY = "system_config";
function tenantConfigKey(tenantId) {
  return `tenant:${tenantId}:config`;
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

function normalizeTenantId(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function resolveTenantId(req) {
  if (req.staff?.role !== "owner") {
    return req.staff?.tenantId || null;
  }
  const raw = req.query?.tenantId || req.body?.tenantId || req.staff?.tenantId || null;
  return normalizeTenantId(raw);
}

function requireVoucherPolicyWriteRole(req, res, next) {
  if (!req.staff) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  if (!["owner", "operator", "agent"].includes(req.staff.role)) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }
  return next();
}

async function getSystemConfig() {
  const cfg = await getJson(SYSTEM_CONFIG_KEY, null);
  if (!cfg || typeof cfg !== "object") return { ...DEFAULT_SYSTEM_CONFIG };
  const merged = { ...DEFAULT_SYSTEM_CONFIG, ...cfg };
  merged.voucherWinCapPolicy = normalizeVoucherWinCapPolicy(merged.voucherWinCapPolicy);
  return merged;
}

router.get("/", staffAuth, async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const system = await getSystemConfig();
    const tenant = tenantId ? await getJson(tenantConfigKey(tenantId), {}) : {};
    const tenantNormalized = { ...(tenant || {}) };
    if (Object.prototype.hasOwnProperty.call(tenantNormalized, "voucherWinCapPolicy")) {
      tenantNormalized.voucherWinCapPolicy = normalizeVoucherWinCapPolicy(
        tenantNormalized.voucherWinCapPolicy
      );
    }
    const effective = { ...system, ...tenantNormalized };
    effective.voucherWinCapPolicy = normalizeVoucherWinCapPolicy(effective.voucherWinCapPolicy);
    return res.json({ ok: true, tenantId, system, tenant: tenantNormalized, effective });
  } catch (err) {
    console.error("[CONFIG] load error:", err);
    return res.status(500).json({ ok: false, error: "Failed to load tenant config" });
  }
});

router.get("/voucher-win-cap/options", staffAuth, async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const system = await getSystemConfig();
    const tenant = tenantId ? await getJson(tenantConfigKey(tenantId), {}) : {};
    const effective = { ...system, ...(tenant || {}) };
    const policy = normalizeVoucherWinCapPolicy(effective?.voucherWinCapPolicy);
    return res.json({
      ok: true,
      tenantId,
      policy,
      options: buildVoucherWinCapOptions(policy),
    });
  } catch (err) {
    console.error("[CONFIG] voucher cap options error:", err);
    return res.status(500).json({ ok: false, error: "Failed to load voucher win cap options" });
  }
});

router.put("/voucher-win-cap/policy", staffAuth, requireVoucherPolicyWriteRole, async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId && req.staff?.role !== "owner") {
      return res.status(400).json({ ok: false, error: "Tenant ID is required" });
    }
    if (!tenantId && req.staff?.role === "owner") {
      return res.status(400).json({ ok: false, error: "Owner must specify tenantId" });
    }

    const incoming = req.body?.voucherWinCapPolicy || req.body?.policy;
    if (!incoming || typeof incoming !== "object") {
      return res.status(400).json({ ok: false, error: "voucherWinCapPolicy must be an object" });
    }

    const current = await getJson(tenantConfigKey(tenantId), {});
    const nextPolicy = normalizeVoucherWinCapPolicy(incoming);
    const merged = { ...(current || {}), voucherWinCapPolicy: nextPolicy };
    await setJson(tenantConfigKey(tenantId), merged);

    const system = await getSystemConfig();
    const effective = { ...system, ...merged };

    return res.json({
      ok: true,
      tenantId,
      policy: nextPolicy,
      tenant: merged,
      effective,
    });
  } catch (err) {
    console.error("[CONFIG] voucher cap policy update error:", err);
    return res.status(500).json({ ok: false, error: "Failed to save voucher win cap policy" });
  }
});

module.exports = router;
