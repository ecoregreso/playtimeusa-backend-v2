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
const SafetyTelemetryEvent = require("./SafetyTelemetryEvent");
const PlayerSafetyLimit = require("./PlayerSafetyLimit");
const PlayerSafetyAction = require("./PlayerSafetyAction");
const StaffKey = require("./StaffKey");
const StaffMessage = require("./StaffMessage");
const StaffPushDevice = require("./StaffPushDevice");
const PurchaseOrder = require("./PurchaseOrder");
const PurchaseOrderMessage = require("./PurchaseOrderMessage");
const OwnerSetting = require("./OwnerSetting");

module.exports = {
  sequelize,
  Sequelize,
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
  SafetyTelemetryEvent,
  PlayerSafetyLimit,
  PlayerSafetyAction,
  StaffKey,
  StaffMessage,
  StaffPushDevice,
  PurchaseOrder,
  PurchaseOrderMessage,
  OwnerSetting,
};
