const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const StaffPushDevice = sequelize.define(
  "StaffPushDevice",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    staffId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    tenantId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "tenant_id",
    },
    deviceType: {
      type: DataTypes.ENUM("web", "fcm", "apns"),
      allowNull: false,
    },
    label: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    platform: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    tokenHash: {
      type: DataTypes.STRING(128),
      allowNull: false,
    },
    encryptedToken: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    lastUsedAt: {
      type: DataTypes.DATE,
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
    tableName: "staff_push_devices",
    timestamps: true,
    indexes: [
      { fields: ["tenantId"] },
      { fields: ["staffId"] },
      { fields: ["tokenHash"] },
    ],
  }
);

module.exports = StaffPushDevice;
