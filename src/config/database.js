// src/config/database.js
require('dotenv').config();
const { Sequelize } = require('sequelize');

const dbUrl =
  process.env.DATABASE_URL ||
  'postgres://playtime_user:playtime_pass@localhost:5432/playtime_db';

const sequelize = new Sequelize(dbUrl, {
  logging: false,
  dialect: 'postgres'
});

module.exports = { sequelize };

