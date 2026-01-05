// src/models/PurchaseOrder.js
const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const PurchaseOrder = sequelize.define(
  "PurchaseOrder",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    funAmount: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: false,
    },
    btcAmount: {
      type: DataTypes.DECIMAL(18, 8),
      allowNull: false,
    },
    btcRate: {
      // FUN per BTC (1 FUN ~= 1 USD)
      type: DataTypes.DECIMAL(18, 2),
      allowNull: true,
    },
    status: {
      // pending -> approved (wallet shared) -> awaiting_credit (agent sent BTC) -> completed (owner credited) -> acknowledged (agent confirmed)
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "pending",
    },
    confirmationCode: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    ownerCreditedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    agentAcknowledgedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    note: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    ownerBtcAddress: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    tenantId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "tenant_id",
    },
    requestedBy: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    requestedById: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  },
  {
    tableName: "purchase_orders",
    timestamps: true,
    indexes: [{ fields: ["requestedBy"] }, { fields: ["tenantId"] }],
  }
);

module.exports = PurchaseOrder;
