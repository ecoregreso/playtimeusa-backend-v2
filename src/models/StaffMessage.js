const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const StaffMessage = sequelize.define(
  "StaffMessage",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    threadId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    fromId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    toId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    tenantId: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    type: {
      type: DataTypes.STRING(48),
      allowNull: false,
      defaultValue: "text",
    },
    ciphertext: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    readAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "staff_messages",
    timestamps: false,
    indexes: [{ fields: ["tenantId"] }],
  }
);

module.exports = StaffMessage;
