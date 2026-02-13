const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const RefreshToken = sequelize.define(
  "RefreshToken",
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "user_id",
    },
    tenantId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "tenant_id",
    },
    role: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    hashedToken: {
      type: DataTypes.TEXT,
      allowNull: false,
      field: "hashed_token",
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "expires_at",
    },
    revokedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "revoked_at",
    },
    revokedReason: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "revoked_reason",
    },
    replacedById: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "replaced_by_id",
    },
    ip: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    userAgent: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "user_agent",
    },
  },
  {
    tableName: "refresh_tokens",
    timestamps: true,
    underscored: true,
  }
);

module.exports = RefreshToken;
