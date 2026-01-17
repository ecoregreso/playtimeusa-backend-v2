const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const WithdrawalIntent = sequelize.define(
  "WithdrawalIntent",
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
      field: "actor_type",
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "user_id",
    },
    sessionId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "session_id",
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
    address: {
      type: DataTypes.TEXT,
      allowNull: false,
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
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "expires_at",
    },
    sentAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "sent_at",
    },
    providerEventId: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "provider_event_id",
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    tableName: "withdrawal_intents",
    timestamps: true,
    indexes: [{ fields: ["tenant_id"] }],
  }
);

module.exports = WithdrawalIntent;
