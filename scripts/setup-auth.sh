#!/usr/bin/env bash
set -e

echo "== Playtime USA auth module setup =="

ROOT_DIR="$(pwd)"

echo "Working in: $ROOT_DIR"

mkdir -p src/models src/utils src/middleware src/routes

echo "Creating src/db.js..."
cat <<'EOF' > src/db.js
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
EOF

echo "Creating src/models/User.js..."
cat <<'EOF' > src/models/User.js
const { DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');
const { sequelize } = require('../db');

const User = sequelize.define('User', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  email: {
    type: DataTypes.STRING(255),
    allowNull: false,
    unique: true,
    validate: { isEmail: true },
  },
  username: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
  },
  passwordHash: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  role: {
    type: DataTypes.ENUM('player', 'cashier', 'agent', 'admin'),
    allowNull: false,
    defaultValue: 'player',
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  },
}, {
  tableName: 'users',
  timestamps: true,
  indexes: [
    { fields: ['email'], unique: true },
    { fields: ['username'], unique: true },
    { fields: ['role'] },
  ],
});

User.prototype.checkPassword = async function (plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

User.createWithPassword = async function ({ email, username, password, role = 'player' }) {
  const saltRounds = 10;
  const passwordHash = await bcrypt.hash(password, saltRounds);
  return User.create({ email, username, passwordHash, role });
};

module.exports = User;
EOF

echo "Creating src/utils/jwt.js..."
cat <<'EOF' > src/utils/jwt.js
const jwt = require('jsonwebtoken');

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const ADMIN_SECRET = process.env.JWT_SECRET;

if (!ACCESS_SECRET || !REFRESH_SECRET || !ADMIN_SECRET) {
  console.warn('[JWT] One or more JWT secrets are missing in .env');
}

function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      type: 'access',
    },
    ACCESS_SECRET,
    { expiresIn: '15m' }
  );
}

function signRefreshToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      type: 'refresh',
    },
    REFRESH_SECRET,
    { expiresIn: '7d' }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_SECRET);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, REFRESH_SECRET);
}

function signAdminToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      type: 'admin',
    },
    ADMIN_SECRET,
    { expiresIn: '1h' }
  );
}

function verifyAdminToken(token) {
  return jwt.verify(token, ADMIN_SECRET);
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  signAdminToken,
  verifyAdminToken,
};
EOF

echo "Creating src/middleware/auth.js..."
cat <<'EOF' > src/middleware/auth.js
const jwt = require('jsonwebtoken');

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const ADMIN_SECRET = process.env.JWT_SECRET;

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    return header.slice(7);
  }
  return null;
}

function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  try {
    const payload = jwt.verify(token, ACCESS_SECRET);
    if (payload.type !== 'access') {
      return res.status(401).json({ error: 'Invalid token type' });
    }
    req.user = {
      id: payload.sub,
      role: payload.role,
    };
    next();
  } catch (err) {
    console.error('[AUTH] Access token error:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role' });
    }
    next();
  };
}

function requireAdminToken(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  try {
    const payload = jwt.verify(token, ADMIN_SECRET);
    if (payload.type !== 'admin') {
      return res.status(401).json({ error: 'Invalid admin token type' });
    }
    req.admin = {
      id: payload.sub,
      role: payload.role,
    };
    next();
  } catch (err) {
    console.error('[AUTH] Admin token error:', err.message);
    return res.status(401).json({ error: 'Invalid or expired admin token' });
  }
}

module.exports = {
  requireAuth,
  requireRole,
  requireAdminToken,
};
EOF

echo "Creating src/routes/auth.js..."
cat <<'EOF' > src/routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  signAdminToken,
} = require('../utils/jwt');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function toPublicUser(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

router.post('/register', async (req, res) => {
  try {
    const { email, username, password, role } = req.body;

    if (!email || !username || !password) {
      return res.status(400).json({ error: 'email, username, and password are required' });
    }

    const existingEmail = await User.findOne({ where: { email } });
    if (existingEmail) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    const existingUsername = await User.findOne({ where: { username } });
    if (existingUsername) {
      return res.status(409).json({ error: 'Username already in use' });
    }

    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const newUser = await User.create({
      email,
      username,
      passwordHash,
      role: role || 'player',
    });

    const accessToken = signAccessToken(newUser);
    const refreshToken = signRefreshToken(newUser);

    return res.status(201).json({
      user: toPublicUser(newUser),
      tokens: {
        accessToken,
        refreshToken,
      },
    });
  } catch (err) {
    console.error('[AUTH] /auth/register error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { emailOrUsername, password } = req.body;

    if (!emailOrUsername || !password) {
      return res.status(400).json({ error: 'emailOrUsername and password are required' });
    }

    const user = await User.findOne({
      where: {
        [User.sequelize.Op.or]: [
          { email: emailOrUsername },
          { username: emailOrUsername },
        ],
      },
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: 'Account disabled' });
    }

    const match = await user.checkPassword(password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);

    return res.json({
      user: toPublicUser(user),
      tokens: {
        accessToken,
        refreshToken,
      },
    });
  } catch (err) {
    console.error('[AUTH] /auth/login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'refreshToken is required' });
    }

    const payload = verifyRefreshToken(refreshToken);

    const user = await User.findByPk(payload.sub);
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Invalid or inactive user' });
    }

    const newAccessToken = signAccessToken(user);
    const newRefreshToken = signRefreshToken(user);

    return res.json({
      user: toPublicUser(user),
      tokens: {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      },
    });
  } catch (err) {
    console.error('[AUTH] /auth/refresh error:', err.message);
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

router.post('/admin/login', async (req, res) => {
  try {
    const { emailOrUsername, password } = req.body;

    if (!emailOrUsername || !password) {
      return res.status(400).json({ error: 'emailOrUsername and password are required' });
    }

    const user = await User.findOne({
      where: {
        [User.sequelize.Op.or]: [
          { email: emailOrUsername },
          { username: emailOrUsername },
        ],
      },
    });

    if (!user || user.role !== 'admin') {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }

    const match = await user.checkPassword(password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }

    const adminToken = signAdminToken(user);
    const accessToken = signAccessToken(user);

    return res.json({
      user: toPublicUser(user),
      tokens: {
        adminToken,
        accessToken,
      },
    });
  } catch (err) {
    console.error('[AUTH] /admin/login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({ user: toPublicUser(user) });
  } catch (err) {
    console.error('[AUTH] /auth/me error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
EOF

echo "Creating src/server.js..."
cat <<'EOF' > src/server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { initDb, sequelize } = require('./db');
const authRoutes = require('./routes/auth');

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
    version: '0.2.0-auth-baseline',
  });
});

app.use('/auth', authRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

(async () => {
  await initDb();

  try {
    await sequelize.sync();
    console.log('[DB] Synced models');
  } catch (err) {
    console.error('[DB] Sync error:', err);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`[SERVER] Listening on port ${PORT}`);
  });
})();
EOF

echo "Installing dependencies..."
npm install express cors sequelize pg pg-hstore bcryptjs jsonwebtoken

echo "== Auth module setup complete =="
echo "Run: npm run dev"
EOF
