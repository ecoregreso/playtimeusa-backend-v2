const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const AuthLockout = sequelize.define(
  "AuthLockout",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    subjectType: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "subject_type",
    },
    subjectId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "subject_id",
    },
    tenantId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "tenant_id",
    },
    failCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: "fail_count",
    },
    lockUntil: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "lock_until",
    },
    lastIp: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "last_ip",
    },
    lastUserAgent: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "last_user_agent",
    },
  },
  {
    tableName: "auth_lockouts",
    timestamps: true,
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ["subject_type", "subject_id", "tenant_id"],
      },
      { fields: ["lock_until"] },
    ],
  }
);

module.exports = AuthLockout;
