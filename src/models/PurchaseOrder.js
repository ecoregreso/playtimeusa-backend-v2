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
      // pending -> approved (owner shared BTC address) -> awaiting_credit (tenant confirmed Wasabi BTC send)
      // -> credited (owner issued exact requested credit amount) -> completed (owner finalized paid + receipt)
      // -> acknowledged (optional tenant acknowledgement)
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
    ownerApprovedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "owner_approved_at",
    },
    paymentConfirmedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "payment_confirmed_at",
    },
    paymentWalletProvider: {
      type: DataTypes.STRING(32),
      allowNull: true,
      field: "payment_wallet_provider",
    },
    creditedAmountCents: {
      type: DataTypes.BIGINT,
      allowNull: true,
      field: "credited_amount_cents",
    },
    receiptCode: {
      type: DataTypes.STRING(64),
      allowNull: true,
      field: "receipt_code",
    },
    receiptIssuedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "receipt_issued_at",
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
    indexes: [{ fields: ["requestedBy"] }, { fields: ["tenant_id"] }],
  }
);

module.exports = PurchaseOrder;
