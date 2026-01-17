const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const PlayerSafetyAction = sequelize.define(
  "PlayerSafetyAction",
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
    sessionId: {
      type: DataTypes.STRING(128),
      allowNull: false,
    },
    gameKey: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    actionType: {
      type: DataTypes.STRING(16),
      allowNull: false,
    },
    reasonCodes: {
      type: DataTypes.JSONB,
      allowNull: false,
    },
    severity: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    details: {
      type: DataTypes.JSONB,
      allowNull: false,
    },
  },
  {
    tableName: "player_safety_actions",
    timestamps: true,
    indexes: [
      { fields: ["tenant_id"] },
      { fields: ["sessionId", "createdAt"] },
      { fields: ["playerId", "createdAt"] },
      { fields: ["actionType", "createdAt"] },
    ],
  }
);

module.exports = PlayerSafetyAction;
