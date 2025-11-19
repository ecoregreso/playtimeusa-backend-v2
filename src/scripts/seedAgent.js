// src/scripts/seedAgent.js
require('dotenv').config();
const { sequelize, Tenant, Wallet } = require('../models');

async function main() {
  try {
    console.log('Using DB URL:', process.env.DATABASE_URL);

    await sequelize.authenticate();
    console.log('[DB] Connected');

    await sequelize.sync({ alter: true });
    console.log('[DB] Synced models');

    const [agent, created] = await Tenant.findOrCreate({
      where: { name: 'Demo Agent 1', type: 'AGENT' },
      defaults: {
        status: 'ACTIVE',
        parentTenantId: null
      }
    });

    console.log(`Agent tenant id: ${agent.id} (created: ${created})`);

    let wallet = await Wallet.findOne({
      where: {
        ownerType: 'TENANT',
        ownerId: agent.id,
        currency: 'FUN'
      }
    });

    if (!wallet) {
      wallet = await Wallet.create({
        ownerType: 'TENANT',
        ownerId: agent.id,
        currency: 'FUN',
        // 5000.00 FUN (assuming 2 decimals → 500000 minor units)
        balanceMinor: 500000
      });
      console.log('Created wallet with 5000.00 FUN');
    } else {
      console.log(
        'Wallet already exists. Current balanceMinor =',
        wallet.balanceMinor
      );
    }

    console.log('Seed complete.');
    process.exit(0);
  } catch (err) {
    console.error('Seed error:', err);
    process.exit(1);
  }
}

main();
