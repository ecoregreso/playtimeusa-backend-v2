const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const GameConfig = sequelize.define(
  "GameConfig",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    gameKey: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
    },
    provider: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    expectedRtp: {
      type: DataTypes.DECIMAL(6, 4),
      allowNull: true,
    },
    volatilityLabel: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
  },
  {
    tableName: "game_configs",
    timestamps: true,
    indexes: [{ fields: ["gameKey"] }, { fields: ["provider"] }],
  }
);

module.exports = GameConfig;
