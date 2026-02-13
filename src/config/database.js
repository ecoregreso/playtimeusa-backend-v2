// src/config/database.js
require('dotenv').config();
const { Sequelize } = require('sequelize');

const isProd = process.env.NODE_ENV === 'production';
const dbUrl = process.env.DATABASE_URL || 'postgres://localhost:5432/playtime_db';

if (isProd && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required in production');
}

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
