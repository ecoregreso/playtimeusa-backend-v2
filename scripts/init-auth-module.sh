#!/usr/bin/env bash
set -e

PROJECT_ROOT="$(pwd)"
echo "[INFO] Using project root: $PROJECT_ROOT"

mkdir -p src/models src/routes src/controllers src/middleware src/utils

#######################################
# models/player.model.js
#######################################
cat > src/models/player.model.js <<'EOF'
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const Player = sequelize.define(
  'Player',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    email: {
      type: DataTypes.STRING(255),
      unique: true,
      allowNull: false,
      validate: {
        isEmail: true,
      },
    },
    username: {
      type: DataTypes.STRING(50),
      unique: true,
      allowNull: false,
    },
    passwordHash: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    role: {
      type: DataTypes.ENUM('player', 'admin'),
      allowNull: false,
      defaultValue: 'player',
    },
    status: {
      type: DataTypes.ENUM('active', 'blocked'),
      allowNull: false,
      defaultValue: 'active',
    },
    balance: {
      type: DataTypes.DECIMAL(18, 4),
      allowNull: false,
      defaultValue: 0.0,
    },
  },
  {
    tableName: 'players',
    indexes: [
      { fields: ['email'] },
      { fields: ['username'] },
    ],
  }
);

module.exports = Player;
EOF

#######################################
# models/index.js (overwrite with Player registration)
#######################################
cat > src/models/index.js <<'EOF'
const { sequelize } = require('../config/database');
const Player = require('./player.model');

const db = {
  sequelize,
  Player,
};

module.exports = db;
EOF

#######################################
# utils/password.js
#######################################
cat > src/utils/password.js <<'EOF'
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 10;

async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

module.exports = {
  hashPassword,
  comparePassword,
};
EOF

#######################################
# utils/jwt.js
#######################################
cat > src/utils/jwt.js <<'EOF'
const jwt = require('jsonwebtoken');
const config = require('../config/env');

function signAccessToken(payload) {
  return jwt.sign(payload, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessExpire,
  });
}

function signRefreshToken(payload) {
  return jwt.sign(payload, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpire,
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, config.jwt.accessSecret);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, config.jwt.refreshSecret);
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
};
EOF

#######################################
# middleware/auth.js
#######################################
cat > src/middleware/auth.js <<'EOF'
const { verifyAccessToken } = require('../utils/jwt');
const { Player } = require('../models');

async function auth(requiredRole = null) {
  return async (req, res, next) => {
    try {
      const header = req.headers['authorization'] || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;

      if (!token) {
        return res.status(401).json({ error: 'Missing authorization token' });
      }

      let decoded;
      try {
        decoded = verifyAccessToken(token);
      } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }

      const player = await Player.findByPk(decoded.id);
      if (!player || player.status === 'blocked') {
        return res.status(401).json({ error: 'Invalid or blocked account' });
      }

      if (requiredRole && player.role !== requiredRole) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      req.user = {
        id: player.id,
        email: player.email,
        username: player.username,
        role: player.role,
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = auth;
EOF

#######################################
# controllers/auth.controller.js
#######################################
cat > src/controllers/auth.controller.js <<'EOF'
const { Player } = require('../models');
const { hashPassword, comparePassword } = require('../utils/password');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../utils/jwt');

function sanitizePlayer(player) {
  return {
    id: player.id,
    email: player.email,
    username: player.username,
    role: player.role,
    status: player.status,
    balance: player.balance,
    createdAt: player.createdAt,
  };
}

async function register(req, res, next) {
  try {
    const { email, username, password } = req.body;

    if (!email || !username || !password) {
      return res.status(400).json({ error: 'email, username and password are required' });
    }

    const existingEmail = await Player.findOne({ where: { email } });
    if (existingEmail) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    const existingUsername = await Player.findOne({ where: { username } });
    if (existingUsername) {
      return res.status(409).json({ error: 'Username already in use' });
    }

    const passwordHash = await hashPassword(password);

    const player = await Player.create({
      email,
      username,
      passwordHash,
    });

    const payload = { id: player.id, role: player.role };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    res.status(201).json({
      user: sanitizePlayer(player),
      tokens: {
        access: accessToken,
        refresh: refreshToken,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { emailOrUsername, password } = req.body;

    if (!emailOrUsername || !password) {
      return res.status(400).json({ error: 'emailOrUsername and password are required' });
    }

    const player = await Player.findOne({
      where: {
        // naive OR logic; better to separate email / username in UI, but this is convenient
        // Sequelize OR:
        // [Op.or]: [{ email: emailOrUsername }, { username: emailOrUsername }],
      },
    });

    // Because we didn't import Op, simple workaround: try email, then username
    let user = player;
    if (!user) {
      user = await Player.findOne({ where: { username: emailOrUsername } });
    }
    if (!user) {
      user = await Player.findOne({ where: { email: emailOrUsername } });
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await comparePassword(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.status === 'blocked') {
      return res.status(403).json({ error: 'Account is blocked' });
    }

    const payload = { id: user.id, role: user.role };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    res.json({
      user: sanitizePlayer(user),
      tokens: {
        access: accessToken,
        refresh: refreshToken,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function me(req, res, next) {
  try {
    // req.user is populated by auth middleware
    const player = await Player.findByPk(req.user.id);
    if (!player) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: sanitizePlayer(player) });
  } catch (err) {
    next(err);
  }
}

async function refresh(req, res, next) {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'refreshToken is required' });
    }

    let decoded;
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const player = await Player.findByPk(decoded.id);
    if (!player || player.status === 'blocked') {
      return res.status(401).json({ error: 'Invalid or blocked account' });
    }

    const payload = { id: player.id, role: player.role };
    const newAccessToken = signAccessToken(payload);
    const newRefreshToken = signRefreshToken(payload);

    res.json({
      user: sanitizePlayer(player),
      tokens: {
        access: newAccessToken,
        refresh: newRefreshToken,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  register,
  login,
  me,
  refresh,
};
EOF

#######################################
# routes/auth.routes.js
#######################################
cat > src/routes/auth.routes.js <<'EOF'
const express = require('express');
const router = express.Router();

const authMiddleware = require('../middleware/auth');
const authController = require('../controllers/auth.controller');

// POST /api/auth/register
router.post('/register', authController.register);

// POST /api/auth/login
router.post('/login', authController.login);

// POST /api/auth/refresh
router.post('/refresh', authController.refresh);

// GET /api/auth/me (requires auth)
router.get('/me', authMiddleware(), authController.me);

module.exports = router;
EOF

#######################################
# routes/index.js (extend to mount /auth)
#######################################
cat > src/routes/index.js <<'EOF'
const express = require('express');
const router = express.Router();

const healthRoutes = require('./health.routes');
const authRoutes = require('./auth.routes');

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);

// future:
// router.use('/cashier', require('./cashier.routes'));

module.exports = router;
EOF

echo "[INFO] Auth module files created."
echo "[INFO] Now install deps: npm install bcryptjs jsonwebtoken"
echo "[INFO] Then restart backend: npm run dev"
EOF
