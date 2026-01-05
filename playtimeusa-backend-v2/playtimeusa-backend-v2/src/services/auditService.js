const { sequelize } = require("../db");

async function setLocal(transaction, key, value) {
  if (value == null || value === "") {
    await sequelize.query(`SET LOCAL ${key} TO DEFAULT`, { transaction });
    return;
  }
  await sequelize.query(`SET LOCAL ${key} = :value`, {
    transaction,
    replacements: { value: String(value) },
  });
}

async function applyContext(transaction, { tenantId, actorRole, actorId }) {
  await setLocal(transaction, "app.tenant_id", tenantId);
  await setLocal(transaction, "app.role", actorRole || "system");
  await setLocal(transaction, "app.user_id", actorId || "system");
}

async function logEvent(event = {}) {
  const {
    eventType,
    success = true,
    tenantId = null,
    requestId = null,
    actorType = null,
    actorId = null,
    actorRole = null,
    actorUsername = null,
    route = null,
    method = null,
    statusCode = null,
    ip = null,
    userAgent = null,
    meta = null,
    transaction = null,
  } = event;

  if (!eventType) return null;

  const sql = `
    INSERT INTO audit_events
      (tenant_id, "eventType", success, "requestId", "actorType", "actorId", "actorRole",
       "actorUsername", route, method, "statusCode", ip, "userAgent", meta, "createdAt", "updatedAt")
    VALUES
      (:tenantId, :eventType, :success, :requestId, :actorType, :actorId, :actorRole,
       :actorUsername, :route, :method, :statusCode, :ip, :userAgent, :meta, NOW(), NOW())
  `;

  const replacements = {
    tenantId,
    eventType,
    success,
    requestId,
    actorType,
    actorId,
    actorRole,
    actorUsername,
    route,
    method,
    statusCode,
    ip,
    userAgent,
    meta,
  };

  try {
    if (transaction) {
      await sequelize.query(sql, { replacements, transaction });
      return;
    }

    await sequelize.transaction(async (t) => {
      await applyContext(t, { tenantId, actorRole, actorId });
      await sequelize.query(sql, { replacements, transaction: t });
    });
  } catch (err) {
    console.warn("[AUDIT] logEvent failed:", err.message || err);
  }
}

module.exports = {
  logEvent,
};
