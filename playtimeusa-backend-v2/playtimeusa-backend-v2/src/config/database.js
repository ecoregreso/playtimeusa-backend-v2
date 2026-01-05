// src/config/database.js
require('dotenv').config();
const { Sequelize } = require('sequelize');

const dbUrl =
  process.env.DATABASE_URL ||
  'postgres://playtime_user:playtime_pass@localhost:5432/playtime_db';

const isProd = process.env.NODE_ENV === 'production';

const sequelize = new Sequelize(dbUrl, {
  dialect: 'postgres',
  logging: false,
  ...(isProd
    ? {
        dialectOptions: {
          ssl: {
            require: true,
            rejectUnauthorized: false
          }
        }
      }
    : {})
});

module.exports = { sequelize };

