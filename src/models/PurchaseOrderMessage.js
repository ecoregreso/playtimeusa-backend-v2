// src/models/PurchaseOrderMessage.js
const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");
const PurchaseOrder = require("./PurchaseOrder");

const PurchaseOrderMessage = sequelize.define(
  "PurchaseOrderMessage",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    orderId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: PurchaseOrder,
        key: "id",
      },
      onDelete: "CASCADE",
    },
    sender: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    senderRole: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    tenantId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "tenant_id",
    },
    body: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
  },
  {
    tableName: "purchase_order_messages",
    timestamps: true,
    indexes: [{ fields: ["orderId"] }, { fields: ["tenant_id"] }],
  }
);

PurchaseOrder.hasMany(PurchaseOrderMessage, {
  foreignKey: "orderId",
  as: "messages",
});
PurchaseOrderMessage.belongsTo(PurchaseOrder, {
  foreignKey: "orderId",
  as: "order",
});

module.exports = PurchaseOrderMessage;
