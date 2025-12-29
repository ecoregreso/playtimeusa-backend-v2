const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const TenantVoucherPool = sequelize.define(
  "TenantVoucherPool",
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
    poolBalanceCents: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "pool_balance_cents",
    },
    currency: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: "FUN",
    },
  },
  {
    tableName: "tenant_voucher_pools",
    timestamps: true,
    indexes: [{ fields: ["tenantId"] }],
  }
);

module.exports = TenantVoucherPool;
