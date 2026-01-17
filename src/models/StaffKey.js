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
      type: DataTypes.UUID,
      allowNull: false,
      field: "tenant_id",
    },
    publicKey: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    // Optional encrypted private key for restoring on login
    encryptedPrivateKey: {
      type: DataTypes.TEXT,
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
    tableName: "staff_keys",
    timestamps: true,
    indexes: [{ fields: ["tenant_id"] }],
  }
);

module.exports = StaffKey;
