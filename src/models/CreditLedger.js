const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const CreditLedger = sequelize.define(
  "CreditLedger",
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
    actorUserId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "actor_user_id",
    },
    actionType: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: "action_type",
    },
    amountCents: {
      type: DataTypes.BIGINT,
      allowNull: false,
      field: "amount_cents",
    },
    memo: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    tableName: "credit_ledger",
    timestamps: true,
    indexes: [{ fields: ["tenantId"] }, { fields: ["actionType"] }],
  }
);

module.exports = CreditLedger;
