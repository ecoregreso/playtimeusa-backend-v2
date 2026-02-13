// src/models/Voucher.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../db');
const User = require('./User');

const Voucher = sequelize.define('Voucher', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  tenantId: {
    type: DataTypes.UUID,
    allowNull: false,
    field: "tenant_id",
  },
  code: {
    type: DataTypes.STRING(32),
    allowNull: false,
  },
  pin: {
    type: DataTypes.STRING(16),
    allowNull: false,
  },
  amount: {
    type: DataTypes.DECIMAL(18, 4),
    allowNull: false,
  },
  bonusAmount: {
    type: DataTypes.DECIMAL(18, 4),
    allowNull: false,
    defaultValue: 0,
  },
  maxCashout: {
    type: DataTypes.DECIMAL(18, 4),
    allowNull: false,
    defaultValue: 0,
    field: "max_cashout",
  },
  currency: {
    type: DataTypes.STRING(16),
    allowNull: false,
    defaultValue: 'FUN',
  },
  // simple string, no Postgres enum nonsense
  status: {
    type: DataTypes.STRING(16),
    allowNull: false,
    defaultValue: 'new', // new | redeemed | cancelled | expired
  },
  redeemedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  metadata: {
    type: DataTypes.JSON,
    allowNull: true,
  },
}, {
  tableName: 'vouchers',
  timestamps: true,
  indexes: [
    { fields: ["tenant_id"] },
    { fields: ["tenant_id", "code"], unique: true },
  ],
});

// created by staff
User.hasMany(Voucher, {
  foreignKey: { name: 'createdByUserId', allowNull: true },
});
Voucher.belongsTo(User, {
  as: 'createdBy',
  foreignKey: { name: 'createdByUserId', allowNull: true },
});

// redeemed by player
User.hasMany(Voucher, {
  foreignKey: { name: 'redeemedByUserId', allowNull: true },
});
Voucher.belongsTo(User, {
  as: 'redeemedBy',
  foreignKey: { name: 'redeemedByUserId', allowNull: true },
});

module.exports = Voucher;
