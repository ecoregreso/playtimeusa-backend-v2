// src/models/Player.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Player = sequelize.define(
  'Player',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    tenantId: {
      type: DataTypes.UUID,
      allowNull: false
    },
    loginCode: {
      type: DataTypes.STRING(6),
      allowNull: false
    },
    pinHash: {
      type: DataTypes.STRING,
      allowNull: false
    },
    status: {
      type: DataTypes.ENUM('ACTIVE', 'CLOSED'),
      allowNull: false,
      defaultValue: 'ACTIVE'
    },
    bonusAckRequired: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    }
  },
  {
    tableName: 'players',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        unique: true,
        fields: ['login_code']
      }
    ]
  }
);

module.exports = Player;
