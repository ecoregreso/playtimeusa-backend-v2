const { Op } = require("sequelize");
const {
  ApiErrorEvent,
  CreditLedger,
  DepositIntent,
  GameConfig,
  GameRound,
  LedgerEvent,
  OwnerSetting,
  PlayerSafetyAction,
  PlayerSafetyLimit,
  PurchaseOrder,
  PurchaseOrderMessage,
  Session,
  SessionSnapshot,
  StaffKey,
  StaffMessage,
  StaffPushDevice,
  StaffUser,
  SupportTicket,
  Tenant,
  TenantVoucherPool,
  TenantWallet,
  Transaction,
  User,
  Voucher,
  Wallet,
  WithdrawalIntent,
} = require("../models");

const TENANT_WIPE_ORDER = [
  PurchaseOrderMessage,
  PurchaseOrder,
  StaffMessage,
  StaffKey,
  StaffPushDevice,
  SessionSnapshot,
  LedgerEvent,
  GameRound,
  Transaction,
  Voucher,
  Session,
  DepositIntent,
  WithdrawalIntent,
  ApiErrorEvent,
  SupportTicket,
  PlayerSafetyAction,
  PlayerSafetyLimit,
  GameConfig,
  Wallet,
  User,
  CreditLedger,
];

async function destroyByTenant(model, tenantId, transaction) {
  await model.destroy({ where: { tenantId }, transaction });
}

async function wipeTenantData(
  tenantId,
  { transaction, resetTenantBalances = true } = {}
) {
  if (!tenantId) {
    throw new Error("tenantId is required");
  }

  for (const model of TENANT_WIPE_ORDER) {
    await destroyByTenant(model, tenantId, transaction);
  }

  await StaffUser.destroy({ where: { tenantId }, transaction });

  if (resetTenantBalances) {
    await TenantWallet.destroy({ where: { tenantId }, transaction });
    await TenantVoucherPool.destroy({ where: { tenantId }, transaction });

    await TenantWallet.create(
      { tenantId, balanceCents: 0, currency: "FUN" },
      { transaction }
    );
    await TenantVoucherPool.create(
      { tenantId, poolBalanceCents: 0, currency: "FUN" },
      { transaction }
    );
  }
}

async function wipeAllData({
  transaction,
  preserveOwners = true,
  preserveOwnerSettings = true,
  resetTenantBalances = true,
} = {}) {
  const tenants = await Tenant.findAll({ attributes: ["id"], transaction });
  for (const tenant of tenants) {
    await wipeTenantData(tenant.id, { transaction, resetTenantBalances });
  }

  if (preserveOwners) {
    await StaffUser.destroy({
      where: { role: { [Op.ne]: "owner" } },
      transaction,
    });
  } else {
    await StaffUser.destroy({ where: {}, transaction });
  }

  if (!preserveOwnerSettings) {
    await OwnerSetting.destroy({ where: {}, transaction });
  }
}

module.exports = {
  wipeTenantData,
  wipeAllData,
};
