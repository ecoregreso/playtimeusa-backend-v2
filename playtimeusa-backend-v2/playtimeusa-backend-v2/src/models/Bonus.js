// src/models/Bonus.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Bonus = sequelize.define(
  'Bonus',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    playerId: {
      type: DataTypes.UUID,
      allowNull: false
    },
    walletId: {
      type: DataTypes.UUID,
      allowNull: false
    },
    sourceVoucherId: {
      type: DataTypes.UUID,
      allowNull: false
    },
    amountMinor: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    triggerBalanceMinor: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 100
    },
    status: {
      type: DataTypes.ENUM('PENDING', 'TRIGGERED', 'CANCELLED'),
      allowNull: false,
      defaultValue: 'PENDING'
    },
    triggeredAt: {
      type: DataTypes.DATE,
      allowNull: true
    }
  },
  {
    tableName: 'bonuses',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ['source_voucher_id']
      }
    ]
  }
);

module.exports = Bonus;
