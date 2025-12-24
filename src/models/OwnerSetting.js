// src/models/OwnerSetting.js
const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const OwnerSetting = sequelize.define(
  "OwnerSetting",
  {
    key: {
      type: DataTypes.STRING,
      primaryKey: true,
    },
    value: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    tableName: "owner_settings",
    timestamps: true,
  }
);

module.exports = OwnerSetting;
