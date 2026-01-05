// src/models/StaffUser.js

const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const StaffUser = sequelize.define(
  'StaffUser',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    tenantId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(160),
      allowNull: false,
      unique: true,
      validate: {
        isEmail: true,
      },
    },
    displayName: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },
    role: {
      type: DataTypes.ENUM('operator', 'agent', 'subagent', 'cashier'),
      allowNull: false,
    },
    passwordHash: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    permissions: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: false,
      defaultValue: [],
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  },
  {
    tableName: 'staff_users',
    underscored: true,
    timestamps: true,
    indexes: [
      { fields: ['tenant_id'] },
      { unique: true, fields: ['email'] },
    ],
  }
);

module.exports = StaffUser;
