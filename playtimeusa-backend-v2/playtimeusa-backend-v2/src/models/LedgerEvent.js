const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const LedgerEvent = sequelize.define(
  "LedgerEvent",
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
    ts: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    playerId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    sessionId: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    actionId: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    agentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    cashierId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    gameKey: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    eventType: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    amountCents: {
      type: DataTypes.INTEGER,
      allowNull: true,
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
    source: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    meta: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    tableName: "ledger_events",
    timestamps: true,
    indexes: [
      { fields: ["ts"] },
      { fields: ["playerId", "ts"] },
      { fields: ["sessionId", "ts"] },
      { fields: ["tenantId", "actionId", "eventType"], unique: true },
      { fields: ["gameKey", "ts"] },
      { fields: ["eventType", "ts"] },
      { fields: ["tenantId"] },
    ],
  }
);

module.exports = LedgerEvent;
