#!/usr/bin/env bash
set -e

API_BASE="http://localhost:3000"

ADMIN_EMAIL="admin@example.com"
ADMIN_USERNAME="admin"
ADMIN_PASSWORD="Test1234!"

TESTPLAYER_EMAIL="player1@example.com"
TESTPLAYER_USERNAME="player1"
TESTPLAYER_PASSWORD="Player123!"

echo "== PlaytimeUSA :: Wallets + Transactions + Test Player =="

ROOT_DIR="$(pwd)"
echo "Working in: $ROOT_DIR"

mkdir -p src/models src/routes

echo "[1] Creating Wallet & Transaction models and model index..."

cat <<'EOF' > src/models/Wallet.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../db');
const User = require('./User');

const Wallet = sequelize.define('Wallet', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  balance: {
    type: DataTypes.DECIMAL(18, 4),
    allowNull: false,
    defaultValue: 0,
  },
  currency: {
    type: DataTypes.STRING(16),
    allowNull: false,
    defaultValue: 'FUN',
  },
}, {
  tableName: 'wallets',
  timestamps: true,
});

User.hasOne(Wallet, {
  foreignKey: { name: 'userId', allowNull: false },
  onDelete: 'CASCADE',
});
Wallet.belongsTo(User, {
  foreignKey: { name: 'userId', allowNull: false },
});

module.exports = Wallet;
EOF

cat <<'EOF' > src/models/Transaction.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../db');
const Wallet = require('./Wallet');
const User = require('./User');

const Transaction = sequelize.define('Transaction', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  type: {
    type: DataTypes.ENUM(
      'credit',
      'debit',
      'voucher_credit',
      'voucher_debit',
      'game_bet',
      'game_win',
      'manual_adjustment'
    ),
    allowNull: false,
  },
  amount: {
    type: DataTypes.DECIMAL(18, 4),
    allowNull: false,
  },
  balanceBefore: {
    type: DataTypes.DECIMAL(18, 4),
    allowNull: false,
  },
  balanceAfter: {
    type: DataTypes.DECIMAL(18, 4),
    allowNull: false,
  },
  reference: {
    type: DataTypes.STRING(128),
    allowNull: true,
  },
  metadata: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
}, {
  tableName: 'transactions',
  timestamps: true,
});

Wallet.hasMany(Transaction, {
  foreignKey: { name: 'walletId', allowNull: false },
  onDelete: 'CASCADE',
});
Transaction.belongsTo(Wallet, {
  foreignKey: { name: 'walletId', allowNull: false },
});

User.hasMany(Transaction, {
  foreignKey: { name: 'createdByUserId', allowNull: true },
});
Transaction.belongsTo(User, {
  as: 'createdBy',
  foreignKey: { name: 'createdByUserId', allowNull: true },
});

module.exports = Transaction;
EOF

cat <<'EOF' > src/models/index.js
const User = require('./User');
const Wallet = require('./Wallet');
const Transaction = require('./Transaction');

module.exports = {
  User,
  Wallet,
  Transaction,
};
EOF

echo "[2] Creating wallet routes..."

cat <<'EOF' > src/routes/wallets.js
const express = require('express');
const { sequelize } = require('../db');
const { User, Wallet, Transaction } = require('../models');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

async function getOrCreateWallet(userId, t) {
  let wallet = await Wallet.findOne({ where: { userId }, transaction: t });
  if (!wallet) {
    wallet = await Wallet.create({ userId, balance: 0 }, { transaction: t });
  }
  return wallet;
}

router.get('/:userId',
  requireAuth,
  requireRole('admin', 'agent', 'cashier'),
  async (req, res) => {
    try {
      const { userId } = req.params;

      const wallet = await Wallet.findOne({
        where: { userId },
      });

      if (!wallet) {
        return res.status(404).json({ error: 'Wallet not found' });
      }

      const transactions = await Transaction.findAll({
        where: { walletId: wallet.id },
        order: [['createdAt', 'DESC']],
        limit: 50,
      });

      return res.json({
        wallet,
        transactions,
      });
    } catch (err) {
      console.error('[WALLET] GET /wallets/:userId error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post('/:userId/credit',
  requireAuth,
  requireRole('admin', 'agent', 'cashier'),
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const { userId } = req.params;
      const { amount, type = 'credit', reference, metadata } = req.body;

      const numericAmount = parseFloat(amount);
      if (!numericAmount || numericAmount <= 0) {
        await t.rollback();
        return res.status(400).json({ error: 'amount must be > 0' });
      }

      const user = await User.findByPk(userId, { transaction: t });
      if (!user) {
        await t.rollback();
        return res.status(404).json({ error: 'User not found' });
      }

      const wallet = await getOrCreateWallet(userId, t);

      const balanceBefore = parseFloat(wallet.balance);
      const balanceAfter = balanceBefore + numericAmount;

      wallet.balance = balanceAfter;
      await wallet.save({ transaction: t });

      const tx = await Transaction.create({
        walletId: wallet.id,
        type,
        amount: numericAmount,
        balanceBefore,
        balanceAfter,
        reference: reference || null,
        metadata: metadata || null,
        createdByUserId: req.user.id,
      }, { transaction: t });

      await t.commit();

      return res.status(201).json({
        wallet,
        transaction: tx,
      });
    } catch (err) {
      console.error('[WALLET] POST /wallets/:userId/credit error:', err);
      await t.rollback();
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post('/:userId/debit',
  requireAuth,
  requireRole('admin', 'agent', 'cashier'),
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const { userId } = req.params;
      const { amount, type = 'debit', reference, metadata } = req.body;

      const numericAmount = parseFloat(amount);
      if (!numericAmount || numericAmount <= 0) {
        await t.rollback();
        return res.status(400).json({ error: 'amount must be > 0' });
      }

      const user = await User.findByPk(userId, { transaction: t });
      if (!user) {
        await t.rollback();
        return res.status(404).json({ error: 'User not found' });
      }

      const wallet = await getOrCreateWallet(userId, t);

      const balanceBefore = parseFloat(wallet.balance);
      if (balanceBefore < numericAmount) {
        await t.rollback();
        return res.status(400).json({ error: 'Insufficient funds' });
      }

      const balanceAfter = balanceBefore - numericAmount;

      wallet.balance = balanceAfter;
      await wallet.save({ transaction: t });

      const tx = await Transaction.create({
        walletId: wallet.id,
        type,
        amount: numericAmount,
        balanceBefore,
        balanceAfter,
        reference: reference || null,
        metadata: metadata || null,
        createdByUserId: req.user.id,
      }, { transaction: t });

      await t.commit();

      return res.status(201).json({
        wallet,
        transaction: tx,
      });
    } catch (err) {
      console.error('[WALLET] POST /wallets/:userId/debit error:', err);
      await t.rollback();
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
EOF

echo "[3] Overwriting src/server.js to wire models + wallets + auth..."

cat <<'EOF' > src/server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { initDb, sequelize } = require('./db');
const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallets');
const models = require('./models');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || '*',
}));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    env: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
  });
});

app.get('/status', (req, res) => {
  res.json({
    name: 'Playtime USA Backend',
    version: '0.3.0-wallets',
  });
});

app.use('/auth', authRoutes);
app.use('/wallets', walletRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

(async () => {
  await initDb();

  try {
    await sequelize.sync();
    console.log('[DB] Synced models (users, wallets, transactions)');
  } catch (err) {
    console.error('[DB] Sync error:', err);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`[SERVER] Listening on port ${PORT}`);
  });
})();
EOF

echo "[4] Restarting dev server (you should have nodemon handling this)..."
# nodemon will auto-restart when files change; nothing to do here.

echo "[5] Checking backend health..."
if ! curl -s "$API_BASE/health" >/dev/null; then
  echo "!! Backend not responding on $API_BASE. Start it with: npm run dev"
  exit 1
fi
echo "   Backend is up."

echo "[6] Logging in as admin to get token..."

LOGIN_BODY=$(cat <<EOF
{
  "emailOrUsername": "$ADMIN_USERNAME",
  "password": "$ADMIN_PASSWORD"
}
EOF
)

LOGIN_RESPONSE=$(curl -s \
  -X POST "$API_BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d "$LOGIN_BODY")

LOGIN_ERROR=$(echo "$LOGIN_RESPONSE" | jq -r '.error // empty')

if [[ -n "$LOGIN_ERROR" ]]; then
  echo "!! Admin login failed: $LOGIN_ERROR"
  echo "Raw response:"
  echo "$LOGIN_RESPONSE"
  exit 1
fi

ADMIN_ACCESS_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.tokens.accessToken')
if [[ -z "$ADMIN_ACCESS_TOKEN" || "$ADMIN_ACCESS_TOKEN" == "null" ]]; then
  echo "!! Could not extract admin access token."
  echo "$LOGIN_RESPONSE"
  exit 1
fi

echo "   Admin token acquired."

echo "[7] Creating test player (if not exists)..."

REGISTER_BODY=$(cat <<EOF
{
  "email": "$TESTPLAYER_EMAIL",
  "username": "$TESTPLAYER_USERNAME",
  "password": "$TESTPLAYER_PASSWORD",
  "role": "player"
}
EOF
)

REGISTER_RESPONSE_FILE=$(mktemp)
REGISTER_STATUS=$(curl -s -o "$REGISTER_RESPONSE_FILE" -w "%{http_code}" \
  -X POST "$API_BASE/auth/register" \
  -H "Content-Type: application/json" \
  -d "$REGISTER_BODY")

if [[ "$REGISTER_STATUS" == "201" ]]; then
  echo "   Created new test player: $TESTPLAYER_EMAIL / $TESTPLAYER_USERNAME"
elif [[ "$REGISTER_STATUS" == "409" ]]; then
  echo "   Test player already exists, continuing..."
else
  echo "!! Unexpected response from /auth/register for test player (HTTP $REGISTER_STATUS):"
  cat "$REGISTER_RESPONSE_FILE"
  rm -f "$REGISTER_RESPONSE_FILE"
  exit 1
fi

rm -f "$REGISTER_RESPONSE_FILE"

echo "[8] Logging in as test player to get ID..."

PLOGIN_BODY=$(cat <<EOF
{
  "emailOrUsername": "$TESTPLAYER_USERNAME",
  "password": "$TESTPLAYER_PASSWORD"
}
EOF
)

PLOGIN_RESPONSE=$(curl -s \
  -X POST "$API_BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d "$PLOGIN_BODY")

PLOGIN_ERROR=$(echo "$PLOGIN_RESPONSE" | jq -r '.error // empty')

if [[ -n "$PLOGIN_ERROR" ]]; then
  echo "!! Test player login failed: $PLOGIN_ERROR"
  echo "Raw response:"
  echo "$PLOGIN_RESPONSE"
  exit 1
fi

PLAYER_ID=$(echo "$PLOGIN_RESPONSE" | jq -r '.user.id')

if [[ -z "$PLAYER_ID" || "$PLAYER_ID" == "null" ]]; then
  echo "!! Could not extract player id."
  echo "$PLOGIN_RESPONSE"
  exit 1
fi

echo "   Test player ID: $PLAYER_ID"

echo "[9] Crediting 1000 FUN to test player's wallet..."

CREDIT_BODY=$(cat <<EOF
{
  "amount": 1000,
  "type": "manual_adjustment",
  "reference": "initial-test-credit",
  "metadata": { "reason": "test-seed" }
}
EOF
)

CREDIT_RESPONSE=$(curl -s \
  -X POST "$API_BASE/wallets/$PLAYER_ID/credit" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" \
  -d "$CREDIT_BODY")

CREDIT_ERROR=$(echo "$CREDIT_RESPONSE" | jq -r '.error // empty')

if [[ -n "$CREDIT_ERROR" ]]; then
  echo "!! Wallet credit failed: $CREDIT_ERROR"
  echo "Raw response:"
  echo "$CREDIT_RESPONSE"
  exit 1
fi

echo "   Credit OK. Wallet snapshot:"
echo "$CREDIT_RESPONSE" | jq '.wallet'

echo
echo "== Done =="
echo "Test player:"
echo "  username: $TESTPLAYER_USERNAME"
echo "  password: $TESTPLAYER_PASSWORD"
echo "  email:    $TESTPLAYER_EMAIL"
echo
echo "Use admin token from dev-auth-flow to inspect wallet:"
echo "  curl http://localhost:3000/wallets/$PLAYER_ID -H \"Authorization: Bearer \$PTU_ADMIN_TOKEN\""
EOF
