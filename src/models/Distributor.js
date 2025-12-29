const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const Distributor = sequelize.define(
  "Distributor",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING(24),
      allowNull: false,
      defaultValue: "active",
    },
  },
  {
    tableName: "distributors",
    timestamps: true,
    indexes: [{ fields: ["name"] }],
  }
);

module.exports = Distributor;
