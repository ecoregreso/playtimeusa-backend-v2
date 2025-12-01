// src/models/voucher.js
module.exports = (sequelize, DataTypes) => {
  const Voucher = sequelize.define(
    'Voucher',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      code: {
        type: DataTypes.STRING(6),
        allowNull: false,
      },
      pin: {
        type: DataTypes.STRING(6),
        allowNull: false,
      },
      amount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
      },
      bonusAmount: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
      },
      totalCredit: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('NEW', 'REDEEMED', 'EXPIRED'),
        allowNull: false,
        defaultValue: 'NEW',
      },
      createdBy: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      redeemedBy: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      redeemedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: 'vouchers',
      underscored: true,
    }
  );

  return Voucher;
};
