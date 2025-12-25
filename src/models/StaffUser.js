const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Staff users power the admin UI (username/password based).
const StaffUser = sequelize.define(
  "StaffUser",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    tenantId: {
      type: DataTypes.STRING(64),
      allowNull: true,
      defaultValue: "default",
    },
    username: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
    },
    passwordHash: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    role: {
      type: DataTypes.ENUM("cashier", "agent", "operator", "owner"),
      allowNull: false,
      defaultValue: "cashier",
    },
    agentCode: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    parentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    permissions: {
      type: DataTypes.JSONB,
      allowNull: true,
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
    tableName: "staff_users",
    timestamps: true,
    indexes: [{ fields: ["tenantId"] }],
  }
);

module.exports = StaffUser;
