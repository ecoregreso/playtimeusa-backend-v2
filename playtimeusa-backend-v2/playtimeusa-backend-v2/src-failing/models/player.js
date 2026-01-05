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
        // Dev-friendly: allow null/duplicate so old rows don't break sync
        type: DataTypes.STRING,
        allowNull: true,
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
