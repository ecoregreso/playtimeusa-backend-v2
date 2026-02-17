// src/models/Tenant.js
const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const Tenant = sequelize.define(
  "Tenant",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    externalId: {
      type: DataTypes.TEXT,
      allowNull: false,
      field: "external_id",
    },
    name: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },
    distributorId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "distributor_id",
    },
    status: {
      type: DataTypes.STRING(24),
      allowNull: false,
      defaultValue: "active",
    },
  },
  {
    tableName: "tenants",
    timestamps: true,
    indexes: [{ fields: ["name"] }, { fields: ["distributor_id"] }, { unique: true, fields: ["external_id"] }],
  }
);

module.exports = Tenant;
