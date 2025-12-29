const geoip = require("geoip-lite");
const { LedgerEvent } = require("../models");

function toCents(value) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * 100);
}

function normalizeIp(value) {
  if (!value) return null;
  const raw = Array.isArray(value) ? value[0] : String(value);
  let ip = raw.split(",")[0].trim();
  if (ip.startsWith("::ffff:")) {
    ip = ip.slice(7);
  }
  return ip || null;
}

function geoFromIp(ip) {
  if (!ip) return {};
  const lookup = geoip.lookup(ip);
  if (!lookup) return {};
  return {
    country: lookup.country || null,
    region: lookup.region || null,
    city: lookup.city || null,
  };
}

function buildRequestMeta(req, extra = {}) {
  const ip = normalizeIp(req?.ip || req?.headers?.["x-forwarded-for"]);
  return {
    ip,
    userAgent: req?.get ? req.get("user-agent") : null,
    ...geoFromIp(ip),
    ...extra,
  };
}

async function recordLedgerEvent(payload) {
  try {
    const actionId = payload?.actionId ? String(payload.actionId) : null;
    if (actionId) {
      const [event] = await LedgerEvent.findOrCreate({
        where: { actionId, eventType: payload.eventType },
        defaults: { ...payload, actionId },
      });
      return event;
    }
    return await LedgerEvent.create(payload);
  } catch (err) {
    console.warn("[LEDGER] failed to record event:", err.message || err);
    return null;
  }
}

module.exports = {
  toCents,
  buildRequestMeta,
  recordLedgerEvent,
};
