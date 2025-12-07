const { DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');
const { sequelize } = require('../db');

const User = sequelize.define('User', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  email: {
    type: DataTypes.STRING(255),
    allowNull: false,
    unique: true,
    validate: { isEmail: true },
  },
  username: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
  },
  passwordHash: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  role: {
    type: DataTypes.ENUM('player', 'cashier', 'agent', 'admin'),
    allowNull: false,
    defaultValue: 'player',
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
}, {
  tableName: 'users',
  timestamps: true,
  indexes: [
    { fields: ['email'], unique: true },
    { fields: ['username'], unique: true },
    { fields: ['role'] },
  ],
});

User.prototype.checkPassword = async function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

User.createWithPassword = async function ({ email, username, password, role = 'player' }) {
  const saltRounds = 10;
  const passwordHash = await bcrypt.hash(password, saltRounds);
  return User.create({ email, username, passwordHash, role });
};

module.exports = User;
