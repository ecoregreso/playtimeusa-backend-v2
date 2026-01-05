// src/models/player.js
module.exports = (sequelize, DataTypes) => {
  const Player = sequelize.define(
    'Player',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      username: {
        type: DataTypes.STRING,
        allowNull: true,   // dev-friendly
        unique: false,
      },
      balance: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      tableName: 'players',
      underscored: true,
    }
  );

  return Player;
};
