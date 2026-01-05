// scripts/drop-vouchers-table.js
require('dotenv').config();
const { sequelize } = require('../src/models');

async function main() {
  try {
    await sequelize.authenticate();
    console.log('[DB] Connected');

    const qi = sequelize.getQueryInterface();

    console.log('[DB] Dropping vouchers table (if exists)...');
    await qi.dropTable('vouchers');

    console.log('[DB] Done. vouchers table dropped.');
  } catch (err) {
    console.error('[DB] Error dropping vouchers table:', err);
  } finally {
    await sequelize.close();
    process.exit(0);
  }
}

main();
