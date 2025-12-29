const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const DepositIntent = sequelize.define(
  "DepositIntent",
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
    actorType: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "user",
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    sessionId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    provider: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "bitcoin",
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "pending",
    },
    amountFun: {
      type: DataTypes.DECIMAL(18, 6),
      allowNull: false,
      field: "amount_fun",
    },
    amountUsd: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: true,
      field: "amount_usd",
    },
    expectedBtc: {
      type: DataTypes.DECIMAL(18, 8),
      allowNull: true,
      field: "expected_btc",
    },
    rateUsdPerBtc: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: true,
      field: "rate_usd_per_btc",
    },
    address: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    paymentUri: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "payment_uri",
    },
    providerInvoiceId: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "provider_invoice_id",
    },
    providerEventId: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "provider_event_id",
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "expires_at",
    },
    confirmedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "confirmed_at",
    },
    creditedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "credited_at",
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    tableName: "deposit_intents",
    timestamps: true,
    indexes: [{ fields: ["tenantId"] }],
  }
);

module.exports = DepositIntent;
