// src/models/Wallet.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Wallet = sequelize.define(
  'Wallet',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    ownerType: {
      type: DataTypes.ENUM('TENANT', 'PLAYER', 'JACKPOT'),
      allowNull: false
    },
    ownerId: {
      type: DataTypes.UUID,
      allowNull: false
    },
    currency: {
      type: DataTypes.STRING(8),
      allowNull: false,
      defaultValue: 'FUN'
    },
    balanceMinor: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0
    }
  },
  {
    tableName: 'wallets',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ['owner_type', 'owner_id', 'currency']
      }
    ]
  }
);

module.exports = Wallet;
