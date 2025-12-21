const { DataTypes } = require('sequelize');
const { sequelize } = require('../db');
const User = require('./User');

const Wallet = sequelize.define('Wallet', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  balance: {
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
