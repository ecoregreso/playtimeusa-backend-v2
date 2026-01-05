// src/routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const { Tenant, Wallet } = require('../models');

// TEMP: seed a demo agent + wallet
router.post('/seed-demo-agent', async (req, res) => {
  try {
    const [agent, created] = await Tenant.findOrCreate({
      where: { name: 'Demo Agent 1', type: 'AGENT' },
      defaults: {
        status: 'ACTIVE',
        parentTenantId: null
      }
    });

    let wallet = await Wallet.findOne({
      where: {
        ownerType: 'TENANT',
        ownerId: agent.id,
        currency: 'FUN'
      }
    });

    let walletCreated = false;

    if (!wallet) {
      wallet = await Wallet.create({
        ownerType: 'TENANT',
        ownerId: agent.id,
        currency: 'FUN',
        balanceMinor: 500000  // 5000.00 FUN
      });
      walletCreated = true;
    }

    return res.json({
      ok: true,
      agent: {
        id: agent.id,
        name: agent.name,
        type: agent.type,
        status: agent.status,
        created
      },
      wallet: {
        id: wallet.id,
        balanceMinor: wallet.balanceMinor,
        currency: wallet.currency,
        created: walletCreated
      }
    });
  } catch (err) {
    console.error('[ADMIN SEED ERROR]', err);
    return res.status(500).json({
      ok: false,
      error: 'seed_failed',
      details: err.message
    });
  }
});

module.exports = router;
