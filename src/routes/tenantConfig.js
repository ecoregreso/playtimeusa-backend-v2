// src/routes/tenantConfig.js
const express = require("express");
const { staffAuth } = require("../middleware/staffAuth");
const { getJson } = require("../utils/ownerSettings");

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

async function getSystemConfig() {
  const cfg = await getJson(SYSTEM_CONFIG_KEY, null);
  if (!cfg || typeof cfg !== "object") return { ...DEFAULT_SYSTEM_CONFIG };
  return { ...DEFAULT_SYSTEM_CONFIG, ...cfg };
}

router.get("/", staffAuth, async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    const system = await getSystemConfig();
    const tenant = tenantId ? await getJson(tenantConfigKey(tenantId), {}) : {};
    const effective = { ...system, ...(tenant || {}) };
    return res.json({ ok: true, tenantId, system, tenant: tenant || {}, effective });
  } catch (err) {
    console.error("[CONFIG] load error:", err);
    return res.status(500).json({ ok: false, error: "Failed to load tenant config" });
  }
});

module.exports = router;
