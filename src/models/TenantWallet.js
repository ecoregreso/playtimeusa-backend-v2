const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const TenantWallet = sequelize.define(
  "TenantWallet",
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
    balanceCents: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "balance_cents",
    },
    currency: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: "FUN",
    },
  },
  {
    tableName: "tenant_wallets",
    timestamps: true,
    indexes: [{ fields: ["tenantId"] }],
  }
);

module.exports = TenantWallet;
