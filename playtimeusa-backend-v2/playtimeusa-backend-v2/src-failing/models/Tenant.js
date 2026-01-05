// src/models/Tenant.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Tenant = sequelize.define(
  'Tenant',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    name: {
      type: DataTypes.STRING(120),
      allowNull: false
    },
    type: {
      type: DataTypes.ENUM('DEV', 'OPERATOR', 'DISTRIBUTOR', 'AGENT'),
      allowNull: false
    },
    parentTenantId: {
      type: DataTypes.UUID,
      allowNull: true
    },
    status: {
      type: DataTypes.ENUM('ACTIVE', 'DISABLED'),
      allowNull: false,
      defaultValue: 'ACTIVE'
    }
  },
  {
    tableName: 'tenants',
    timestamps: true,
    underscored: true
  }
);

module.exports = Tenant;
