// src/models/index.js
const { sequelize } = require('../config/database');

const Tenant = require('./Tenant');
const Wallet = require('./Wallet');
const Player = require('./Player');
const Voucher = require('./Voucher');
const Bonus = require('./Bonus');
const Bet = require('./Bet');
const LedgerEntry = require('./LedgerEntry');

Tenant.hasMany(Player, { foreignKey: 'tenantId' });
Player.belongsTo(Tenant, { foreignKey: 'tenantId' });

Voucher.belongsTo(Tenant, { foreignKey: 'tenantId' });
Voucher.belongsTo(Player, {
  foreignKey: 'playerUsedId',
  as: 'playerUsed'
});

Bonus.belongsTo(Player, { foreignKey: 'playerId' });
Bonus.belongsTo(Wallet, { foreignKey: 'walletId' });
Bonus.belongsTo(Voucher, { foreignKey: 'sourceVoucherId' });

Bet.belongsTo(Player, { foreignKey: 'playerId' });

LedgerEntry.belongsTo(Wallet, {
  foreignKey: 'fromWalletId',
  as: 'fromWallet'
});
LedgerEntry.belongsTo(Wallet, {
  foreignKey: 'toWalletId',
  as: 'toWallet'
});

module.exports = {
  sequelize,
  Tenant,
  Wallet,
  Player,
  Voucher,
  Bonus,
  Bet,
  LedgerEntry
};
