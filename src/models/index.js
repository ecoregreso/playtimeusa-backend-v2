// src/models/index.js
const { Sequelize } = require("sequelize");
const { sequelize } = require("../db");

const User = require("./User");
const Wallet = require("./Wallet");
const Transaction = require("./Transaction");
const Voucher = require("./Voucher");
const GameRound = require("./GameRound");
const StaffUser = require("./StaffUser");
const Session = require("./Session");
const DepositIntent = require("./DepositIntent");
const WithdrawalIntent = require("./WithdrawalIntent");
const LedgerEvent = require("./LedgerEvent");
const SessionSnapshot = require("./SessionSnapshot");
const GameConfig = require("./GameConfig");
const ApiErrorEvent = require("./ApiErrorEvent");
const SupportTicket = require("./SupportTicket");
const PlayerSafetyLimit = require("./PlayerSafetyLimit");
const PlayerSafetyAction = require("./PlayerSafetyAction");
const StaffKey = require("./StaffKey");
const StaffMessage = require("./StaffMessage");
const StaffPushDevice = require("./StaffPushDevice");
const PurchaseOrder = require("./PurchaseOrder");
const PurchaseOrderMessage = require("./PurchaseOrderMessage");
const OwnerSetting = require("./OwnerSetting");
const Tenant = require("./Tenant");
const Distributor = require("./Distributor");
const TenantWallet = require("./TenantWallet");
const TenantVoucherPool = require("./TenantVoucherPool");
const CreditLedger = require("./CreditLedger");
const Jackpot = require("./Jackpot");
const JackpotEvent = require("./JackpotEvent");
const JackpotContribution = require("./JackpotContribution");
const ShiftClosure = require("./ShiftClosure");
const RefreshToken = require("./RefreshToken");
const AuthLockout = require("./AuthLockout");

Tenant.hasMany(User, { foreignKey: "tenantId" });
User.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(StaffUser, { foreignKey: "tenantId" });
StaffUser.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(Voucher, { foreignKey: "tenantId" });
Voucher.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(Wallet, { foreignKey: "tenantId" });
Wallet.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(Transaction, { foreignKey: "tenantId" });
Transaction.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(GameRound, { foreignKey: "tenantId" });
GameRound.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(Session, { foreignKey: "tenantId" });
Session.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(DepositIntent, { foreignKey: "tenantId" });
DepositIntent.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(WithdrawalIntent, { foreignKey: "tenantId" });
WithdrawalIntent.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(LedgerEvent, { foreignKey: "tenantId" });
LedgerEvent.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(SessionSnapshot, { foreignKey: "tenantId" });
SessionSnapshot.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(GameConfig, { foreignKey: "tenantId" });
GameConfig.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(ApiErrorEvent, { foreignKey: "tenantId" });
ApiErrorEvent.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(SupportTicket, { foreignKey: "tenantId" });
SupportTicket.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(PlayerSafetyLimit, { foreignKey: "tenantId" });
PlayerSafetyLimit.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(PlayerSafetyAction, { foreignKey: "tenantId" });
PlayerSafetyAction.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(StaffKey, { foreignKey: "tenantId" });
StaffKey.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(StaffMessage, { foreignKey: "tenantId" });
StaffMessage.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(StaffPushDevice, { foreignKey: "tenantId" });
StaffPushDevice.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(PurchaseOrder, { foreignKey: "tenantId" });
PurchaseOrder.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(PurchaseOrderMessage, { foreignKey: "tenantId" });
PurchaseOrderMessage.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(TenantWallet, { foreignKey: "tenantId" });
TenantWallet.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(TenantVoucherPool, { foreignKey: "tenantId" });
TenantVoucherPool.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(CreditLedger, { foreignKey: "tenantId" });
CreditLedger.belongsTo(Tenant, { foreignKey: "tenantId" });

Tenant.hasMany(ShiftClosure, { foreignKey: "tenantId" });
ShiftClosure.belongsTo(Tenant, { foreignKey: "tenantId" });
StaffUser.hasMany(ShiftClosure, { foreignKey: "staffId" });
ShiftClosure.belongsTo(StaffUser, { foreignKey: "staffId" });

Distributor.hasMany(Tenant, { foreignKey: "distributorId" });
Tenant.belongsTo(Distributor, { foreignKey: "distributorId" });

Tenant.hasMany(Jackpot, { foreignKey: "tenantId" });
Jackpot.belongsTo(Tenant, { foreignKey: "tenantId" });

Jackpot.hasMany(JackpotEvent, { foreignKey: "jackpotId" });
JackpotEvent.belongsTo(Jackpot, { foreignKey: "jackpotId" });

Jackpot.hasMany(JackpotContribution, { foreignKey: "jackpotId" });
JackpotContribution.belongsTo(Jackpot, { foreignKey: "jackpotId" });

module.exports = {
  sequelize,
  Sequelize,
  Tenant,
  Distributor,
  User,
  Wallet,
  Transaction,
  Voucher,
  GameRound,
  StaffUser,
  Session,
  DepositIntent,
  WithdrawalIntent,
  LedgerEvent,
  SessionSnapshot,
  GameConfig,
  ApiErrorEvent,
  SupportTicket,
  PlayerSafetyLimit,
  PlayerSafetyAction,
  StaffKey,
  StaffMessage,
  StaffPushDevice,
  PurchaseOrder,
  PurchaseOrderMessage,
  OwnerSetting,
  TenantWallet,
  TenantVoucherPool,
  CreditLedger,
  Jackpot,
  JackpotEvent,
  JackpotContribution,
  ShiftClosure,
  RefreshToken,
  AuthLockout,
};
