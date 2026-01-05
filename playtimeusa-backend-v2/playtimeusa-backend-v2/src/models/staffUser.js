// src/models/staffUser.js
const { DataTypes } = require('sequelize');
const sequelize = require('../../config/database');

const StaffUser = sequelize.define(
  'StaffUser',
  {
    username: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
    },
    passwordHash: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },
    role: {
      // cashier: vouchers + read-only history
      // agent: manages cashiers, sees their players
      // operator: full platform admin (except owners)
      // distributor: distributor operator account
      // owner: you, god mode
      type: DataTypes.ENUM('cashier', 'agent', 'operator', 'distributor', 'owner'),
      allowNull: false,
      defaultValue: 'cashier',
    },
    agentCode: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    parentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    permissions: {
      // extra JSON flags later (canViewPlayers, canEditAgents, etc.)
      type: DataTypes.JSONB || DataTypes.JSON,
      allowNull: true,
    },
  },
  {
    tableName: 'staff_users',
    timestamps: true,
  }
);

module.exports = StaffUser;
