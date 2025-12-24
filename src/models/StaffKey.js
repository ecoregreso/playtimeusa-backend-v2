const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const StaffKey = sequelize.define(
  "StaffKey",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    staffId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
    },
    tenantId: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    publicKey: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: "staff_keys",
    timestamps: true,
    indexes: [{ fields: ["tenantId"] }],
  }
);

module.exports = StaffKey;
