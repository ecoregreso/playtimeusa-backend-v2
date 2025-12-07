const { Sequelize } = require('sequelize');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('[DB] DATABASE_URL is not set in .env');
  process.exit(1);
}

const sequelize = new Sequelize(connectionString, {
  dialect: 'postgres',
  logging: process.env.LOG_LEVEL === 'debug' ? console.log : false,
  dialectOptions: {
    ssl: process.env.PGSSLMODE === 'require'
      ? { require: true, rejectUnauthorized: false }
      : undefined,
  },
});

async function initDb() {
  try {
    await sequelize.authenticate();
    console.log('[DB] Connected to Postgres');
  } catch (err) {
    console.error('[DB] Connection error:', err.message);
    process.exit(1);
  }
}

module.exports = {
  sequelize,
  initDb,
};
