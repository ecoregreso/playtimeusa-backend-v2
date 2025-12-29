const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const SessionSnapshot = sequelize.define(
  "SessionSnapshot",
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
    sessionId: {
      type: DataTypes.STRING(128),
      allowNull: false,
    },
    playerId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    startedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    endedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    startBalanceCents: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    endBalanceCents: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    totalBetsCents: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    totalWinsCents: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    netCents: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    gameCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    spins: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    tableName: "session_snapshots",
    timestamps: true,
    indexes: [
      { fields: ["tenantId"] },
      { fields: ["startedAt"] },
      { fields: ["endedAt"] },
      { fields: ["playerId", "startedAt"] },
    ],
  }
);

module.exports = SessionSnapshot;
