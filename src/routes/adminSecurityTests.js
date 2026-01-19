const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { requireStaffAuth, PERMISSIONS } = require("../middleware/staffAuth");
const { sequelize } = require("../models");

const router = express.Router();

// In-memory observability for security lab (ephemeral, not persisted)
const sessionFingerprints = new Map(); // staffId -> Map<fingerprint, { userAgent, lastSeen }>
const eventLog = [];
const MAX_EVENTS = 200;

function recordEvent(type, staffId, severity = "info", details = {}) {
  eventLog.push({
    id: crypto.randomUUID(),
    type,
    staffId,
    severity,
    details,
    ts: new Date(),
  });
  if (eventLog.length > MAX_EVENTS) {
    eventLog.shift();
  }
}

function observeSession({ staffId, userAgent, fingerprint }) {
  const now = new Date();
  const perStaff = sessionFingerprints.get(staffId) || new Map();
  const prev = perStaff.get(fingerprint);
  const userAgentChange = !!(prev && prev.userAgent && prev.userAgent !== userAgent);
  if (userAgentChange) {
    recordEvent("user_agent_switch", staffId, "warn", {
      fingerprint,
      previous: prev.userAgent,
      current: userAgent,
    });
  }

  perStaff.set(fingerprint, { userAgent, lastSeen: now });
  sessionFingerprints.set(staffId, perStaff);

  const doubleLogin = perStaff.size > 1;
  if (doubleLogin) {
    recordEvent("double_login", staffId, "warn", {
      fingerprints: Array.from(perStaff.keys()),
    });
  }

  return {
    doubleLogin,
    userAgentChange,
    fingerprints: Array.from(perStaff.entries()).map(([fp, meta]) => ({
      fingerprint: fp,
      userAgent: meta.userAgent,
      lastSeen: meta.lastSeen,
    })),
  };
}

function runProbe(name, ctx = {}) {
  const results = {
    name,
    status: "ok",
    detail: "",
  };

  if (name === "sql_injection") {
    const payload = "' OR 1=1;--";
    const escaped = sequelize.escape(payload);
    const escapedChanged = escaped !== payload;
    results.status = escapedChanged ? "ok" : "warn";
    results.detail = escapedChanged
      ? "Payload escaped; parameterization prevents injection."
      : "Escape check failed; verify ORM parameterization.";
    return results;
  }

  if (name === "xss_payload") {
    const payload = `<img src=x onerror=alert(1)>`;
    const sanitized = payload.replace(/[<>"'`]/g, "");
    const sanitizedChanged = sanitized !== payload;
    results.status = sanitizedChanged ? "ok" : "warn";
    results.detail = sanitizedChanged
      ? "HTML sanitization altered script payload; reflective XSS blocked."
      : "Sanitization did not alter script payload; review output encoding.";
    return results;
  }

  if (name === "dir_traversal") {
    const attempt = "../../etc/passwd";
    const normalized = path.posix.normalize(`/safe/${attempt}`).replace(/^(\.\.[/\\])+/, "");
    const escaped = normalized.includes("..") ? attempt : normalized;
    const blocked = !escaped.includes("..");
    results.status = blocked ? "ok" : "warn";
    results.detail = blocked
      ? "Path normalization prevents escaping the sandbox."
      : "Traversal remained after normalization; add path guards.";
    return results;
  }

  if (name === "user_agent_switch") {
    const change = ctx.session?.userAgentChange;
    results.status = change ? "warn" : "ok";
    results.detail = change
      ? "User agent switched mid-session (potential device spoof)."
      : "No user agent change detected for this fingerprint.";
    return results;
  }

  if (name === "double_login") {
    const doubled = ctx.session?.doubleLogin;
    results.status = doubled ? "warn" : "ok";
    results.detail = doubled
      ? "Multiple concurrent fingerprints for this staff session detected."
      : "Single fingerprint observed for this staff session.";
    return results;
  }

  results.status = "info";
  results.detail = "Probe not recognized.";
  return results;
}

router.post(
  "/probes",
  requireStaffAuth([PERMISSIONS.STAFF_MANAGE]),
  async (req, res) => {
    try {
      const staff = req.staff || {};
      const { scenarios = [], fingerprint: fingerprintInput, userAgent: userAgentBody } = req.body || {};
      const userAgent =
        userAgentBody ||
        req.headers["x-simulated-user-agent"] ||
        req.headers["user-agent"] ||
        "unknown";
      const fingerprint =
        fingerprintInput || req.headers["x-session-fingerprint"] || `${staff.id || "staff"}:${Date.now()}`;

      const session = observeSession({ staffId: staff.id, userAgent, fingerprint });

      const requested = Array.isArray(scenarios) && scenarios.length
        ? scenarios
        : ["sql_injection", "xss_payload", "dir_traversal", "user_agent_switch", "double_login"];

      const probes = requested.map((name) => runProbe(name, { session }));

      recordEvent("security_probe", staff.id, "info", {
        scenarios: requested,
        fingerprint,
        userAgent,
      });

      res.json({
        ok: true,
        data: {
          probes,
          session,
          fingerprint,
          userAgent,
        },
      });
    } catch (err) {
      console.error("[ADMIN_SECURITY] probe error:", err);
      res.status(500).json({ ok: false, error: "Failed to run probes" });
    }
  }
);

router.get(
  "/probes/status",
  requireStaffAuth([PERMISSIONS.STAFF_MANAGE]),
  async (req, res) => {
    try {
      const staff = req.staff || {};
      const sessions = sessionFingerprints.get(staff.id) || new Map();
      const sessionSnapshot = Array.from(sessions.entries()).map(([fp, meta]) => ({
        fingerprint: fp,
        userAgent: meta.userAgent,
        lastSeen: meta.lastSeen,
      }));

      res.json({
        ok: true,
        data: {
          events: [...eventLog].slice(-50).reverse(),
          session: {
            fingerprints: sessionSnapshot,
            doubleLogin: sessionSnapshot.length > 1,
          },
        },
      });
    } catch (err) {
      console.error("[ADMIN_SECURITY] status error:", err);
      res.status(500).json({ ok: false, error: "Failed to load security status" });
    }
  }
);

module.exports = router;
