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
    note: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    ownerBtcAddress: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    requestedBy: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: "purchase_orders",
    timestamps: true,
    indexes: [{ fields: ["requestedBy"] }],
  }
);

module.exports = PurchaseOrder;
