// src/models/Bet.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Bet = sequelize.define(
  'Bet',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    playerId: {
      type: DataTypes.UUID,
      allowNull: false
    },
    gameCode: {
      type: DataTypes.STRING(64),
      allowNull: false
    },
    stakeMinor: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    winMinor: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0
    },
    outcome: {
      type: DataTypes.STRING(32),
      allowNull: false
    }
  },
  {
    tableName: 'bets',
    timestamps: true,
    underscored: true
  }
);

module.exports = Bet;
