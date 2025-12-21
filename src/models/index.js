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
};
