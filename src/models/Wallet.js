const { DataTypes } = require('sequelize');
const { sequelize } = require('../db');
const User = require('./User');
const Voucher = require('./Voucher');

const Wallet = sequelize.define('Wallet', {
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
  balance: {
    type: DataTypes.DECIMAL(18, 4),
    allowNull: false,
    defaultValue: 0,
  },
  bonusPending: {
    type: DataTypes.DECIMAL(18, 4),
    allowNull: false,
    defaultValue: 0,
  },
  bonusUnacked: {
    type: DataTypes.DECIMAL(18, 4),
    allowNull: false,
    defaultValue: 0,
  },
  currency: {
    type: DataTypes.STRING(16),
    allowNull: false,
    defaultValue: 'FUN',
  },
  activeVoucherId: {
    type: DataTypes.UUID,
    allowNull: true,
    field: "active_voucher_id",
  },
}, {
  tableName: 'wallets',
  timestamps: true,
  indexes: [{ fields: ["tenant_id"] }, { fields: ["active_voucher_id"] }],
});

User.hasOne(Wallet, {
  as: 'wallet',
  foreignKey: { name: 'userId', allowNull: false },
  onDelete: 'CASCADE',
});
Wallet.belongsTo(User, {
  as: 'user',
  foreignKey: { name: 'userId', allowNull: false },
});

Voucher.hasMany(Wallet, {
  as: 'activeWallets',
  foreignKey: { name: 'activeVoucherId', allowNull: true },
});
Wallet.belongsTo(Voucher, {
  as: 'activeVoucher',
  foreignKey: { name: 'activeVoucherId', allowNull: true },
});

module.exports = Wallet;
