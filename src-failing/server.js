require('dotenv').config();

const express = require('express');
const cors = require('cors');

const { sequelize } = require('./models');
const cashierRouter = require('./routes/cashier');
const adminAuthRouter = require('./routes/adminAuth');
const adminRouter = require('./routes/admin');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/cashier', cashierRouter);
app.use('/api/auth/admin', adminAuthRouter);
app.use('/api/admin', adminRouter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await sequelize.authenticate();
    await sequelize.sync({ alter: true });
    console.log('DB synced');

    app.listen(PORT, () => console.log(`Server running on ${PORT}`));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
