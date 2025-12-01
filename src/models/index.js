// src/models/index.js
const { Sequelize, DataTypes } = require('sequelize');

const useSsl =
  process.env.PGSSLMODE === 'require' ||
  process.env.DB_USE_SSL === 'true' ||
  process.env.DB_USE_SSL === '1';

console.log(
  `[DB] Using Postgres via DATABASE_URL (${useSsl ? 'SSL enabled' : 'no SSL'})`
);

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  dialectOptions: useSsl
    ? {
        ssl: {
          require: true,
          rejectUnauthorized: false,
        },
      }
    : {},
});

const db = {};

db.sequelize = sequelize;
db.Sequelize = Sequelize;

// Models
db.Voucher = require('./voucher')(sequelize, DataTypes);
db.Player = require('./player')(sequelize, DataTypes);

module.exports = db;
