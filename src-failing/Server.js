// src/server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');

const { sequelize } = require('./models');
const cashierRouter = require('./routes/cashier');
const adminAuthRouter = require('./routes/adminAuth');
const adminRouter = require('./routes/admin');

const app = express();

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/cashier', cashierRouter);
app.use('/api/auth/admin', adminAuthRouter);
app.use('/api/admin', adminRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  });
});

app.get('/health', (req, res) => {
  res.send('OK');
});

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await sequelize.authenticate();
    console.log('[DB] Connected to Postgres');

    // Dev mode: auto-sync models to DB schema
    await sequelize.sync({ alter: true });
    console.log('[DB] Synced models (alter)');

    app.listen(PORT, () => {
      console.log(`[SERVER] Playtime backend v2 listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('[STARTUP] error:', err);
    process.exit(1);
  }
})();
