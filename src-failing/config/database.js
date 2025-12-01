const { Sequelize } = require('sequelize');
const config = require('./env');

const useSsl = /render\.com|amazonaws\.com|herokuapp\.com|railway\.app/i.test(
  config.databaseUrl || ''
);

console.log(
  `[DB] Using Postgres via DATABASE_URL${useSsl ? ' (SSL enabled)' : ''}`
);

const sequelize = new Sequelize(config.databaseUrl, {
  dialect: 'postgres',
  logging: config.isDev ? console.log : false,
  dialectOptions: useSsl
    ? {
        ssl: {
          require: true,
          rejectUnauthorized: false,
        },
      }
    : {},
});

async function initDatabase() {
  try {
    await sequelize.authenticate();
    console.log('[DB] Connected to Postgres');

    // Plug models here later, then sync
    await sequelize.sync({ alter: false });
    console.log('[DB] Synced models');
  } catch (err) {
    console.error('[DB] Error initializing database:', err);
    throw err;
  }
}

module.exports = {
  sequelize,
  initDatabase,
};
