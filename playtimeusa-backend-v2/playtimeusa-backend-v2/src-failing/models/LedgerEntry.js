// src/models/LedgerEntry.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const LedgerEntry = sequelize.define(
  'LedgerEntry',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    fromWalletId: {
      type: DataTypes.UUID,
      allowNull: true
    },
    toWalletId: {
      type: DataTypes.UUID,
      allowNull: true
    },
    amountMinor: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    type: {
      type: DataTypes.STRING(64),
      allowNull: false
    },
    refType: {
      type: DataTypes.STRING(32),
      allowNull: true
    },
    refId: {
      type: DataTypes.UUID,
      allowNull: true
    }
  },
  {
    tableName: 'ledger_entries',
    timestamps: true,
    underscored: true
  }
);

module.exports = LedgerEntry;
