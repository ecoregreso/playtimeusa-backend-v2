const { Tenant, Distributor } = require("../models");

function normalizeTenantIdentifier(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function isUuidLike(value) {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value));
}

async function findTenantByIdentifier(identifier, options = {}) {
  const normalized = normalizeTenantIdentifier(identifier);
  if (!normalized) return null;

  const queryOptions = {};
  if (options.transaction) queryOptions.transaction = options.transaction;
  if (options.lock) queryOptions.lock = options.lock;

  // Prefer external_id lookup so free-form identifiers always work, even if they look UUID-like.
  const byExternalId = await Tenant.findOne({
    where: { externalId: normalized },
    ...queryOptions,
  });
  if (byExternalId) return byExternalId;

  if (!isUuidLike(normalized)) return null;

  return Tenant.findByPk(normalized, queryOptions);
}

async function resolveTenantUuid(identifier, options = {}) {
  const tenant = await findTenantByIdentifier(identifier, options);
  return tenant?.id || null;
}

async function isTenantIdentifierTaken(identifier, options = {}) {
  const normalized = normalizeTenantIdentifier(identifier);
  if (!normalized) return false;

  const queryOptions = {};
  if (options.transaction) queryOptions.transaction = options.transaction;
  if (options.lock) queryOptions.lock = options.lock;

  const [tenantById, tenantByExternalId, distributorById] = await Promise.all([
    isUuidLike(normalized) ? Tenant.findByPk(normalized, queryOptions) : Promise.resolve(null),
    Tenant.findOne({ where: { externalId: normalized }, ...queryOptions }),
    isUuidLike(normalized) ? Distributor.findByPk(normalized, queryOptions) : Promise.resolve(null),
  ]);

  return Boolean(tenantById || tenantByExternalId || distributorById);
}

module.exports = {
  normalizeTenantIdentifier,
  isUuidLike,
  findTenantByIdentifier,
  resolveTenantUuid,
  isTenantIdentifierTaken,
};
