// src/server.js
require('dotenv').config();
const app = require('./app');
const { sequelize } = require('./models');

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await sequelize.authenticate();
    console.log('[DB] Connected to Postgres');
    await sequelize.sync({ alter: true });
    console.log('[DB] Synced models');

    app.listen(PORT, () => {
      console.log(`[SERVER] Playtime backend v2 listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('[STARTUP] error:', err);
    process.exit(1);
  }
})();
