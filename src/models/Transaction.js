const { DataTypes } = require('sequelize');
const { sequelize } = require('../db');
const Wallet = require('./Wallet');
const User = require('./User');

const Transaction = sequelize.define('Transaction', {
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
  type: {
    type: DataTypes.ENUM(
      'credit',
      'debit',
      'voucher_credit',
      'voucher_debit',
      'game_bet',
      'game_win',
      'manual_adjustment'
    ),
    allowNull: false,
  },
  amount: {
    type: DataTypes.DECIMAL(18, 4),
    allowNull: false,
  },
  balanceBefore: {
    type: DataTypes.DECIMAL(18, 4),
    allowNull: false,
  },
  balanceAfter: {
    type: DataTypes.DECIMAL(18, 4),
    allowNull: false,
  },
  reference: {
    type: DataTypes.STRING(128),
    allowNull: true,
  },
  metadata: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
}, {
  tableName: 'transactions',
  timestamps: true,
  indexes: [{ fields: ["tenant_id"] }],
});

Wallet.hasMany(Transaction, {
  as: 'transactions',
  foreignKey: { name: 'walletId', allowNull: false },
  onDelete: 'CASCADE',
});
Transaction.belongsTo(Wallet, {
  as: 'wallet',
  foreignKey: { name: 'walletId', allowNull: false },
});

User.hasMany(Transaction, {
  foreignKey: { name: 'createdByUserId', allowNull: true },
});
Transaction.belongsTo(User, {
  as: 'createdBy',
  foreignKey: { name: 'createdByUserId', allowNull: true },
});

module.exports = Transaction;
