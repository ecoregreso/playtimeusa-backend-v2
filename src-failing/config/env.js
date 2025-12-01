require('dotenv').config();

const env = process.env.NODE_ENV || 'development';

const config = {
  env,
  isDev: env === 'development',
  isTest: env === 'test',
  isProd: env === 'production',

  port: parseInt(process.env.PORT, 10) || 3000,

  databaseUrl: process.env.DATABASE_URL,

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
    accessExpire: '15m',
    refreshExpire: '30d',
  },

  logLevel: process.env.LOG_LEVEL || (env === 'production' ? 'info' : 'debug'),
};

if (!config.databaseUrl) {
  console.warn('[ENV] WARNING: DATABASE_URL is not set. Database will fail.');
}

module.exports = config;
