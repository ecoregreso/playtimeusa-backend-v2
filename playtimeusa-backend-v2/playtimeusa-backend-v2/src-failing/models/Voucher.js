// src/models/Voucher.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Voucher = sequelize.define(
  'Voucher',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    tenantId: {
      type: DataTypes.UUID,
      allowNull: false
    },
    code: {
      type: DataTypes.STRING(32),
      allowNull: false,
      unique: true
    },
    pinHash: {
      type: DataTypes.STRING,
      allowNull: false
    },
    amountMinor: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    bonusAmountMinor: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    totalCostMinor: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    status: {
      type: DataTypes.ENUM('NEW', 'USED', 'EXPIRED', 'CANCELLED'),
      allowNull: false,
      defaultValue: 'NEW'
    },
    playerUsedId: {
      type: DataTypes.UUID,
      allowNull: true
    },
    prizeWheelEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },
    prizeWheelSpun: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    }
  },
  {
    tableName: 'vouchers',
    timestamps: true,
    underscored: true
  }
);

module.exports = Voucher;
