const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const PlayerSafetyLimit = sequelize.define(
  "PlayerSafetyLimit",
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
    lossLimitCents: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    lockedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: "player_safety_limits",
    timestamps: true,
    indexes: [{ fields: ["sessionId"] }, { fields: ["playerId"] }],
  }
);

module.exports = PlayerSafetyLimit;
