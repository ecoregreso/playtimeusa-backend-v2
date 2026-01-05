// config/database.js
require('dotenv').config();
const { Sequelize } = require('sequelize');

const useSsl = process.env.DB_SSL === 'true';

const commonOptions = {
  dialect: 'postgres',
  logging: false,
  dialectOptions: useSsl
    ? {
        ssl: {
          require: true,
          rejectUnauthorized: false
        }
      }
    : {}
};

let sequelize;

// Prefer DATABASE_URL (Render / remote DB / also fine for local dev)
if (process.env.DATABASE_URL) {
  sequelize = new Sequelize(process.env.DATABASE_URL, commonOptions);
  console.log('[DB] Using Postgres via DATABASE_URL', useSsl ? '(SSL enabled)' : '(no SSL)');
} else {
  // Fallback: local Postgres with individual env vars
  const dbName = process.env.DB_NAME;
  const dbUser = process.env.DB_USER;
  const dbPass = process.env.DB_PASS;
  const dbHost = process.env.DB_HOST || '127.0.0.1';
  const dbPort = process.env.DB_PORT || 5432;

  if (!dbName || !dbUser) {
    throw new Error('Missing DB_NAME or DB_USER in environment variables');
  }

  sequelize = new Sequelize(dbName, dbUser, dbPass, {
    ...commonOptions,
    host: dbHost,
    port: dbPort
  });

  console.log(
    `[DB] Using Postgres at ${dbHost}:${dbPort}/${dbName}`,
    useSsl ? '(SSL enabled)' : '(no SSL)'
  );
}

module.exports = sequelize;
