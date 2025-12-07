// src/models/index.js
const { Sequelize } = require("sequelize");

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("[DB] Missing env DATABASE_URL");
  process.exit(1);
}

const sequelize = new Sequelize(databaseUrl, {
  dialect: "postgres",
  logging: process.env.DB_LOGGING === "true" ? console.log : false,
  dialectOptions: {
    ssl: process.env.PGSSLMODE
      ? { require: true, rejectUnauthorized: false }
      : false,
  },
});

// These are class-based models that already bind themselves to sequelize
// internally via Model.init(..., { sequelize })
const User = require("./User");
const Wallet = require("./Wallet");
const Transaction = require("./Transaction");
const Voucher = require("./Voucher");
const GameRound = require("./GameRound");

// StaffUser is a factory: (sequelize) => StaffUserModel
const StaffUserFactory = require("./StaffUser");
const StaffUser =
  typeof StaffUserFactory === "function"
    ? StaffUserFactory(sequelize)
    : StaffUserFactory;

module.exports = {
  sequelize,
  Sequelize,
  User,
  Wallet,
  Transaction,
  Voucher,
  GameRound,
  StaffUser,
};
