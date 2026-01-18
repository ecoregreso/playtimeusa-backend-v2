const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const Jackpot = sequelize.define(
  "Jackpot",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    type: {
      type: DataTypes.STRING(16),
      allowNull: false, // hourly | daily | weekly
    },
    tenantId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "tenant_id",
    },
    currentPotCents: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "current_pot_cents",
    },
    triggerCents: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "trigger_cents",
    },
    rangeMinCents: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "range_min_cents",
    },
    rangeMaxCents: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "range_max_cents",
    },
    contributionBps: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: "contribution_bps",
    },
    lastHitAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "last_hit_at",
    },
    nextDrawAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "next_draw_at",
    },
  },
  {
    tableName: "jackpots",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    indexes: [{ fields: ["type", "tenant_id"] }],
  }
);

module.exports = Jackpot;
