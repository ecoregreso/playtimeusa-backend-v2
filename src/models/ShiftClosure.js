const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const ShiftClosure = sequelize.define(
  "ShiftClosure",
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
    staffId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "staff_id",
    },
    startAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "start_at",
    },
    endAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "end_at",
    },
    summary: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    checklist: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    expectedBalance: {
      type: DataTypes.DECIMAL(18, 4),
      allowNull: true,
      field: "expected_balance",
    },
    actualBalance: {
      type: DataTypes.DECIMAL(18, 4),
      allowNull: true,
      field: "actual_balance",
    },
    closedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: DataTypes.NOW,
      field: "closed_at",
    },
  },
  {
    tableName: "shift_closures",
    underscored: true,
  }
);

module.exports = ShiftClosure;
