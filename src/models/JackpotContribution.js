const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const JackpotContribution = sequelize.define(
  "JackpotContribution",
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
    day: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    amountCents: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "amount_cents",
    },
    contributionsCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: "contributions_count",
    },
  },
  {
    tableName: "jackpot_contributions",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    indexes: [{ unique: true, fields: ["jackpot_id", "day"] }],
  }
);

module.exports = JackpotContribution;
