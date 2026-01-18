const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const JackpotEvent = sequelize.define(
  "JackpotEvent",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    jackpotId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "jackpot_id",
    },
    tenantId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "tenant_id",
    },
    playerId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "player_id",
    },
    eventType: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: "hit",
      field: "event_type",
    },
    amountCents: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "amount_cents",
    },
    potBeforeCents: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "pot_before_cents",
    },
    potAfterCents: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "pot_after_cents",
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    tableName: "jackpot_events",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: false,
    indexes: [
      { fields: ["jackpot_id", "created_at"] },
      { fields: ["tenant_id", "created_at"] },
    ],
  }
);

module.exports = JackpotEvent;
