const { DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');
const { sequelize } = require('../db');

const User = sequelize.define('User', {
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
  email: {
    type: DataTypes.STRING(255),
    allowNull: false,
    validate: { isEmail: true },
  },
  username: {
    type: DataTypes.STRING(64),
    allowNull: false,
  },
  passwordHash: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  role: {
    type: sequelize.getDialect() === "sqlite"
      ? DataTypes.STRING
      : DataTypes.ENUM('player', 'cashier', 'agent', 'admin'),
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
    { fields: ["tenant_id"] },
    { fields: ["tenant_id", "email"], unique: true },
    { fields: ["tenant_id", "username"], unique: true },
    { fields: ['role'] },
  ],
});

User.prototype.checkPassword = async function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

User.createWithPassword = async function ({
  email,
  username,
  password,
  tenantId,
  role = "player",
}) {
  const saltRounds = 10;
  const passwordHash = await bcrypt.hash(password, saltRounds);
  return User.create({ email, username, passwordHash, role, tenantId });
};

module.exports = User;
