// src/models/GameRound.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../db');
const User = require('./User');

const GameRound = sequelize.define('GameRound', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  playerId: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  gameId: {
    type: DataTypes.STRING(64),
    allowNull: false,
  },
  roundIndex: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  betAmount: {
    type: DataTypes.DECIMAL(18, 4),
    allowNull: false,
  },
  winAmount: {
    type: DataTypes.DECIMAL(18, 4),
    allowNull: false,
    defaultValue: 0,
  },
  currency: {
    type: DataTypes.STRING(16),
    allowNull: false,
    defaultValue: 'FUN',
  },
  status: {
    type: DataTypes.STRING(16),
    allowNull: false,
    defaultValue: 'pending', // pending | settled
  },
  rtpSample: {
    // winAmount / betAmount for this round
    type: DataTypes.DECIMAL(10, 6),
    allowNull: true,
  },
  result: {
    // symbols, reels, etc.
    type: DataTypes.JSON,
    allowNull: true,
  },
  metadata: {
    // any extra info (device, session, etc.)
    type: DataTypes.JSON,
    allowNull: true,
  },
}, {
  tableName: 'game_rounds',
  timestamps: true,
});

// relations
User.hasMany(GameRound, {
  foreignKey: { name: 'playerId', allowNull: false },
});
GameRound.belongsTo(User, {
  as: 'player',
  foreignKey: { name: 'playerId', allowNull: false },
});

module.exports = GameRound;
