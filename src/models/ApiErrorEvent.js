const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const ApiErrorEvent = sequelize.define(
  "ApiErrorEvent",
  {
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
    ts: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    route: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    method: {
      type: DataTypes.STRING(12),
      allowNull: true,
    },
    statusCode: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    message: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    meta: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    tableName: "api_error_events",
    timestamps: true,
    indexes: [
      { fields: ["tenant_id"] },
      { fields: ["ts"] },
      { fields: ["route", "ts"] },
    ],
  }
);

module.exports = ApiErrorEvent;
