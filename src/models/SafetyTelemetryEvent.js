const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const SafetyTelemetryEvent = sequelize.define(
  "SafetyTelemetryEvent",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    playerId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    sessionId: {
      type: DataTypes.STRING(128),
      allowNull: false,
    },
    gameKey: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    eventType: {
      type: DataTypes.STRING(16),
      allowNull: false,
    },
    betCents: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    winCents: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    balanceCents: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    clientTs: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    meta: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    tableName: "safety_telemetry_events",
    timestamps: true,
    indexes: [
      { fields: ["sessionId", "createdAt"] },
      { fields: ["playerId", "createdAt"] },
      { fields: ["gameKey", "createdAt"] },
    ],
  }
);

module.exports = SafetyTelemetryEvent;
