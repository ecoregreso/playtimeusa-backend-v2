#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "== [1/9] Ensure src/ exists (extract src.zip if needed) =="
if [[ ! -d src ]]; then
  if [[ -f src.zip ]]; then
    unzip -q src.zip -d .
  else
    echo "ERROR: src/ missing and src.zip not found." >&2
    exit 1
  fi
fi

echo "== [2/9] Backup touched files =="
ts="$(date +%Y%m%d_%H%M%S)"
backup() { [[ -f "$1" ]] && cp -a "$1" "$1.bak.$ts"; }
backup src/app.js
backup src/config/env.js
backup src/config/database.js
backup src/models/index.js
backup src/routes/index.js
backup src/routes/admin.js
backup src/routes/adminAuth.js
backup src/middleware/adminAuth.js

echo "== [3/9] Add dependency for rate limiting (safe) =="
if ! node -e "require('express-rate-limit')" >/dev/null 2>&1; then
  npm i express-rate-limit@^7.4.0
fi

echo "== [4/9] Patch env config: CORS allowlist + separate secrets for admin/staff =="
cat > src/config/env.js <<'JS'
require('dotenv').config();

const env = process.env.NODE_ENV || 'development';

function splitList(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const config = {
  env,
  isDev: env === 'development',
  isTest: env === 'test',
  isProd: env === 'production',

  port: parseInt(process.env.PORT, 10) || 3000,
  databaseUrl: process.env.DATABASE_URL,

  // Comma-separated allowlist
  // Example:
  // CORS_ORIGINS=http://localhost:5173,http://localhost:3001,https://admin-ui-v2.onrender.com
  corsOrigins: splitList(process.env.CORS_ORIGINS || process.env.FRONTEND_ORIGIN),

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
  },

  // Separate JWT secrets for staff/admin (fallback to accessSecret in dev)
  staffJwtSecret:
    process.env.STAFF_JWT_SECRET || process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
  adminJwtSecret:
    process.env.ADMIN_JWT_SECRET || process.env.JWT_ACCESS_SECRET || 'dev-access-secret',

  // Bootstrap secret MUST be set in prod
  adminBootstrapSecret: process.env.ADMIN_BOOTSTRAP_SECRET || 'dev-bootstrap',

  logLevel: process.env.LOG_LEVEL || (env === 'production' ? 'info' : 'debug'),
};

if (!config.databaseUrl) {
  console.warn('[ENV] WARNING: DATABASE_URL is not set. Database will fail.');
}

if (config.isProd) {
  const badJwt =
    config.jwt.accessSecret === 'dev-access-secret' ||
    config.jwt.refreshSecret === 'dev-access-secret' ||
    config.staffJwtSecret === 'dev-access-secret' ||
    config.adminJwtSecret === 'dev-access-secret';

  if (badJwt) {
    console.error('[ENV] FATAL: JWT secrets are using dev defaults in production.');
    console.error('Set JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, STAFF_JWT_SECRET, ADMIN_JWT_SECRET.');
    process.exit(1);
  }

  if (!config.corsOrigins.length) {
    console.error('[ENV] FATAL: CORS_ORIGINS empty in production.');
    process.exit(1);
  }

  if (!process.env.ADMIN_BOOTSTRAP_SECRET || process.env.ADMIN_BOOTSTRAP_SECRET === 'dev-bootstrap') {
    console.error('[ENV] FATAL: ADMIN_BOOTSTRAP_SECRET must be set (and not dev-bootstrap) in production.');
    process.exit(1);
  }
}

module.exports = config;
JS

echo "== [5/9] Fix DB: single sequelize instance + models loaded before sync =="
cat > src/models/index.js <<'JS'
// src/models/index.js
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const db = {};
db.sequelize = sequelize;

db.Player = require('./player');                 // exports a model (already bound)
db.Voucher = require('./voucher')(sequelize, DataTypes);
db.AdminUser = require('./adminUser')(sequelize, DataTypes);
db.StaffUser = require('./staffUser');          // exports a model (already bound)

module.exports = db;
JS

cat > src/config/database.js <<'JS'
const { Sequelize } = require('sequelize');
const config = require('./env');

const useSsl = /render\.com|amazonaws\.com|herokuapp\.com|railway\.app/i.test(
  config.databaseUrl || ''
);

console.log(
  `[DB] Using Postgres via DATABASE_URL${useSsl ? ' (SSL enabled)' : ''}`
);

const sequelize = new Sequelize(config.databaseUrl, {
  dialect: 'postgres',
  logging: config.isDev ? console.log : false,
  dialectOptions: useSsl
    ? {
        ssl: {
          require: true,
          rejectUnauthorized: false,
        },
      }
    : {},
});

async function initDatabase() {
  try {
    await sequelize.authenticate();
    console.log('[DB] Connected to Postgres');

    // IMPORTANT: Load models BEFORE sync, otherwise Sequelize has nothing to sync.
    require('../models');

    await sequelize.sync({ alter: false });
    console.log('[DB] Synced models');
  } catch (err) {
    console.error('[DB] Error initializing database:', err);
    throw err;
  }
}

module.exports = {
  sequelize,
  initDatabase,
};
JS

echo "== [6/9] Add StaffUser model (Admin UI expects /api/v1/staff/login) =="
cat > src/models/staffUser.js <<'JS'
const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const StaffUser = sequelize.define(
  'StaffUser',
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenantId: { type: DataTypes.UUID, allowNull: true },
    username: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    displayName: { type: DataTypes.STRING(120), allowNull: false },
    role: {
      // matches common UI expectations (your UI checks for "owner" in vouchers page)
      type: DataTypes.ENUM('owner', 'operator', 'agent', 'subagent', 'cashier', 'admin'),
      allowNull: false,
      defaultValue: 'operator',
    },
    passwordHash: { type: DataTypes.STRING(255), allowNull: false },
    permissions: { type: DataTypes.ARRAY(DataTypes.STRING), allowNull: false, defaultValue: [] },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  {
    tableName: 'staff_users',
    underscored: true,
    timestamps: true,
    indexes: [{ unique: true, fields: ['username'] }],
  }
);

module.exports = StaffUser;
JS

echo "== [7/9] Staff auth service + routes + vouchers v1 + admin fixes =="
mkdir -p src/services src/routes/v1 src/middleware public/qr/vouchers

cat > src/services/staffAuthService.js <<'JS'
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { StaffUser } = require('../models');

const TTL = process.env.STAFF_JWT_TTL || '12h';

async function authenticateStaff({ username, password, tenantId = null }) {
  const u = String(username || '').trim().toLowerCase();
  const staff = await StaffUser.findOne({ where: { username: u, isActive: true } });

  if (!staff) {
    const err = new Error('invalid_credentials');
    err.status = 401;
    throw err;
  }

  // Optional tenant scoping (UI sends tenantId sometimes)
  if (tenantId && String(staff.tenantId || '') !== String(tenantId)) {
    const err = new Error('invalid_tenant');
    err.status = 401;
    throw err;
  }

  const ok = await bcrypt.compare(String(password || ''), staff.passwordHash);
  if (!ok) {
    const err = new Error('invalid_credentials');
    err.status = 401;
    throw err;
  }

  const payload = {
    sub: staff.id,
    type: 'staff',
    role: staff.role,
    tenantId: staff.tenantId,
    perms: staff.permissions || [],
  };

  const token = jwt.sign(payload, config.staffJwtSecret, { expiresIn: TTL });

  return {
    ok: true,
    token,
    staff: {
      id: staff.id,
      tenantId: staff.tenantId,
      username: staff.username,
      displayName: staff.displayName,
      role: staff.role,
      permissions: staff.permissions || [],
    },
  };
}

module.exports = { authenticateStaff };
JS

cat > src/middleware/staffAuth.js <<'JS'
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { StaffUser } = require('../models');

async function authStaff(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const [, token] = authHeader.split(' ');
    if (!token) return res.status(401).json({ error: 'missing_token' });

    const payload = jwt.verify(token, config.staffJwtSecret);
    if (payload?.type !== 'staff') return res.status(401).json({ error: 'invalid_token' });

    const staff = await StaffUser.findByPk(payload.sub);
    if (!staff || !staff.isActive) return res.status(401).json({ error: 'invalid_staff' });

    req.staff = {
      id: staff.id,
      tenantId: staff.tenantId,
      username: staff.username,
      displayName: staff.displayName,
      role: staff.role,
      permissions: staff.permissions || [],
    };

    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

module.exports = { authStaff };
JS

cat > src/routes/v1/staff.routes.js <<'JS'
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');

const { authenticateStaff } = require('../../services/staffAuthService');
const { authStaff } = require('../../middleware/staffAuth');

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password, tenantId = null } = req.body || {};
    const result = await authenticateStaff({ username, password, tenantId });
    return res.status(200).json(result);
  } catch (e) {
    const status = e.status || 401;
    return res.status(status).json({ ok: false, error: 'Invalid username or password' });
  }
});

router.post('/logout', (req, res) => {
  // Stateless JWT logout (client clears token)
  return res.status(200).json({ ok: true });
});

router.get('/me', authStaff, (req, res) => {
  return res.status(200).json({ ok: true, staff: req.staff });
});

module.exports = router;
JS

cat > src/routes/v1/vouchers.routes.js <<'JS'
const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const router = express.Router();
const { Voucher } = require('../../models');
const { authStaff } = require('../../middleware/staffAuth');

function sixDigits() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function asLowerStatus(s) {
  const v = String(s || '').toUpperCase();
  if (v === 'NEW') return 'new';
  if (v === 'REDEEMED') return 'redeemed';
  if (v === 'EXPIRED') return 'expired';
  return String(s || '').toLowerCase();
}

router.get('/', authStaff, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 500);
  const rows = await Voucher.findAll({ order: [['createdAt', 'DESC']], limit });

  // UI expects array
  const out = rows.map((v) => {
    const j = v.toJSON();
    j.status = asLowerStatus(j.status);
    j.metadata = { userCode: j.code };
    return j;
  });

  return res.json(out);
});

router.post('/', authStaff, async (req, res) => {
  const amount = Number(req.body?.amount);
  const bonusAmount = Number(req.body?.bonusAmount || 0);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Amount must be > 0' });
  }
  if (!Number.isFinite(bonusAmount) || bonusAmount < 0) {
    return res.status(400).json({ error: 'Bonus must be >= 0' });
  }

  const code = sixDigits();
  const pin = sixDigits();
  const totalCredit = Number(amount) + Number(bonusAmount);

  const voucher = await Voucher.create({
    code,
    pin,
    amount,
    bonusAmount,
    totalCredit,
    status: 'NEW',
    createdBy: req.staff?.username || null,
  });

  // Generate QR image file your UI can load via API_BASE_URL/{qr.path}
  const relPath = `api/v1/vouchers/qr/${voucher.id}.png`;
  const absPath = path.join(process.cwd(), 'public', 'qr', 'vouchers', `${voucher.id}.png`);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  // Keep the QR payload simple and deterministic
  const qrPayload = `ptu://voucher?code=${code}&pin=${pin}&id=${voucher.id}`;
  await QRCode.toFile(absPath, qrPayload, { width: 420, margin: 1 });

  return res.status(201).json({
    voucher: {
      ...voucher.toJSON(),
      status: 'new',
      metadata: { userCode: code },
    },
    userCode: code,
    pin,
    qr: { path: relPath },
  });
});

router.get('/qr/:id.png', async (req, res) => {
  const absPath = path.join(process.cwd(), 'public', 'qr', 'vouchers', `${req.params.id}.png`);
  if (!fs.existsSync(absPath)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/png');
  return res.sendFile(absPath);
});

module.exports = router;
JS

echo "== [8/9] Fix admin auth to use ADMIN_JWT_SECRET + mount v1 routes =="
cat > src/middleware/adminAuth.js <<'JS'
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { AdminUser } = require('../models');

async function authAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const [, token] = authHeader.split(' ');
    if (!token) return res.status(401).json({ error: 'missing_token' });

    const payload = jwt.verify(token, config.adminJwtSecret);
    const admin = await AdminUser.findByPk(payload.sub);

    if (!admin || !admin.isActive) {
      return res.status(401).json({ error: 'invalid_admin' });
    }

    req.admin = { id: admin.id, email: admin.email, role: admin.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

function requireRole(requiredRole) {
  return (req, res, next) => {
    if (!req.admin) return res.status(401).json({ error: 'unauthorized' });
    if (req.admin.role !== requiredRole) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

module.exports = { authAdmin, requireRole };
JS

cat > src/routes/adminAuth.js <<'JS'
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();

const config = require('../config/env');
const { AdminUser } = require('../models');

// POST /api/auth/admin/bootstrap
router.post('/bootstrap', async (req, res) => {
  try {
    const { secret, email, password } = req.body;

    if (secret !== config.adminBootstrapSecret) {
      return res.status(403).json({ error: 'invalid_bootstrap_secret' });
    }
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const existing = await AdminUser.findOne({ where: { email } });
    if (existing) return res.status(400).json({ error: 'admin_already_exists' });

    const passwordHash = await bcrypt.hash(password, 10);
    const admin = await AdminUser.create({ email, passwordHash, role: 'ADMIN' });

    return res.status(201).json({ id: admin.id, email: admin.email, role: admin.role });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

// POST /api/auth/admin/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const admin = await AdminUser.findOne({ where: { email } });
    if (!admin || !admin.isActive) return res.status(401).json({ error: 'invalid_credentials' });

    const valid = await bcrypt.compare(password, admin.passwordHash);
    if (!valid) return res.status(401).json({ error: 'invalid_credentials' });

    const token = jwt.sign({ sub: admin.id, role: admin.role }, config.adminJwtSecret, {
      expiresIn: '12h',
    });

    return res.status(200).json({
      token,
      admin: { id: admin.id, email: admin.email, role: admin.role },
    });
  } catch (err) {
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
JS

cat > src/routes/admin.js <<'JS'
const express = require('express');
const router = express.Router();
const { Player, Voucher } = require('../models');
const { authAdmin, requireRole } = require('../middleware/adminAuth');

router.use(authAdmin);
const onlyAdmin = requireRole('ADMIN');

router.get('/players', onlyAdmin, async (req, res) => {
  const players = await Player.findAll({ order: [['createdAt', 'DESC']], limit: 100 });
  return res.json({ players });
});

router.get('/players/:username', onlyAdmin, async (req, res) => {
  const player = await Player.findOne({ where: { username: req.params.username } });
  if (!player) return res.status(404).json({ error: 'player_not_found' });
  return res.json({ player });
});

router.get('/vouchers', onlyAdmin, async (req, res) => {
  const status = req.query.status ? String(req.query.status).toUpperCase() : null;
  const where = {};
  if (status === 'NEW' || status === 'REDEEMED' || status === 'EXPIRED') where.status = status;

  const vouchers = await Voucher.findAll({ where, order: [['createdAt', 'DESC']], limit: 200 });
  return res.json({ vouchers });
});

module.exports = router;
JS

cat > src/routes/index.js <<'JS'
const express = require('express');
const router = express.Router();

const healthRoutes = require('./health.routes');
const authRoutes = require('./auth.routes');
const adminAuthRoutes = require('./adminAuth');
const adminRoutes = require('./admin');

// v1 routes (Admin UI expects these)
const staffV1 = require('./v1/staff.routes');
const vouchersV1 = require('./v1/vouchers.routes');

router.use('/health', healthRoutes);

// Legacy auth
router.use('/auth', authRoutes);

// Admin auth + admin endpoints
router.use('/auth/admin', adminAuthRoutes);
router.use('/admin', adminRoutes);

// v1 contract for Admin UI
router.use('/v1/staff', staffV1);
router.use('/v1/vouchers', vouchersV1);

// Everything else under /api/v1/... can be explicitly 501'd later if needed.

module.exports = router;
JS

echo "== [9/9] Patch app.js: real CORS + static file serving =="
cat > src/app.js <<'JS'
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const rateLimit = require('express-rate-limit');

const config = require('./config/env');
const routes = require('./routes');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(helmet());

// CORS: allowlist in prod, permissive in dev/test
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl/postman
    if (config.isDev || config.isTest) return cb(null, true);
    if (config.corsOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Id'],
};
app.use(cors(corsOptions));

// Basic global rate-limit (cheap DDoS friction)
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  morgan(config.isDev ? 'dev' : 'combined', {
    stream: { write: (msg) => process.stdout.write(msg) },
  })
);

// Serve QR images & any other static files from /public
app.use(express.static(path.join(process.cwd(), 'public')));

// API
app.use('/api', routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
JS

echo "== DONE =="
echo "Next: set env vars (CORS_ORIGINS, STAFF_JWT_SECRET, ADMIN_JWT_SECRET, ADMIN_BOOTSTRAP_SECRET)."
