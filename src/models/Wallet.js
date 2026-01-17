const { DataTypes } = require('sequelize');
const { sequelize } = require('../db');
const User = require('./User');

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
}, {
  tableName: 'wallets',
  timestamps: true,
  indexes: [{ fields: ["tenant_id"] }],
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

module.exports = Wallet;
