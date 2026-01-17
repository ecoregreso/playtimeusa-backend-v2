const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const SupportTicket = sequelize.define(
  "SupportTicket",
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
    playerId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    assignedStaffId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    status: {
      type: DataTypes.STRING(24),
      allowNull: false,
      defaultValue: "open",
    },
    priority: {
      type: DataTypes.STRING(16),
      allowNull: true,
    },
    category: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    resolvedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    closedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    meta: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    tableName: "support_tickets",
    timestamps: true,
    indexes: [
      { fields: ["tenant_id"] },
      { fields: ["status"] },
      { fields: ["assignedStaffId"] },
      { fields: ["createdAt"] },
    ],
  }
);

module.exports = SupportTicket;
