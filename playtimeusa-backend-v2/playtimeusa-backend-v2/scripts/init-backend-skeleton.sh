#!/usr/bin/env bash
set -e

PROJECT_ROOT="$(pwd)"

echo "[INFO] Using project root: $PROJECT_ROOT"

# 1) Backup existing src if it exists
if [ -d "$PROJECT_ROOT/src" ]; then
  BACKUP_DIR="$PROJECT_ROOT/src_backup_$(date +%Y%m%d_%H%M%S)"
  echo "[INFO] Backing up existing src to $BACKUP_DIR"
  mv "$PROJECT_ROOT/src" "$BACKUP_DIR"
fi

# 2) Create folder structure
echo "[INFO] Creating src structure..."
mkdir -p src/config src/models src/routes src/middleware

#######################################
# config/env.js
#######################################
cat > src/config/env.js <<'EOF'
require('dotenv').config();

const env = process.env.NODE_ENV || 'development';

const config = {
  env,
  isDev: env === 'development',
  isTest: env === 'test',
  isProd: env === 'production',

  port: parseInt(process.env.PORT, 10) || 3000,

  databaseUrl: process.env.DATABASE_URL,

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
    accessExpire: '15m',
    refreshExpire: '30d',
  },

  logLevel: process.env.LOG_LEVEL || (env === 'production' ? 'info' : 'debug'),
};

if (!config.databaseUrl) {
  console.warn('[ENV] WARNING: DATABASE_URL is not set. Database will fail.');
}

module.exports = config;
EOF

#######################################
# config/database.js
#######################################
cat > src/config/database.js <<'EOF'
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

    // Plug models here later, then sync
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
EOF

#######################################
# models/index.js
#######################################
cat > src/models/index.js <<'EOF'
const { sequelize } = require('../config/database');

// Example for later:
// const User = require('./user.model')(sequelize);

const db = {
  sequelize,
  // User,
};

module.exports = db;
EOF

#######################################
# middleware/notFound.js
#######################################
cat > src/middleware/notFound.js <<'EOF'
function notFound(req, res, next) {
  res.status(404).json({
    error: 'Not Found',
    path: req.originalUrl,
  });
}

module.exports = notFound;
EOF

#######################################
# middleware/errorHandler.js
#######################################
cat > src/middleware/errorHandler.js <<'EOF'
const config = require('../config/env');

function errorHandler(err, req, res, next) {
  console.error('[ERROR]', err);

  const status = err.status || err.statusCode || 500;

  const payload = {
    error: err.message || 'Internal Server Error',
  };

  if (config.isDev) {
    payload.stack = err.stack;
    payload.details = err.details || undefined;
  }

  res.status(status).json(payload);
}

module.exports = errorHandler;
EOF

#######################################
# routes/health.routes.js
#######################################
cat > src/routes/health.routes.js <<'EOF'
const express = require('express');
const router = express.Router();
const config = require('../config/env');

router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    env: config.env,
  });
});

module.exports = router;
EOF

#######################################
# routes/index.js
#######################################
cat > src/routes/index.js <<'EOF'
const express = require('express');
const router = express.Router();

const healthRoutes = require('./health.routes');

router.use('/health', healthRoutes);

// future modules:
// router.use('/auth', require('./auth.routes'));
// router.use('/cashier', require('./cashier.routes'));

module.exports = router;
EOF

#######################################
# app.js
#######################################
cat > src/app.js <<'EOF'
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const config = require('./config/env');
const routes = require('./routes');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// Security headers
app.use(helmet());

// CORS
app.use(cors({ origin: '*', credentials: true }));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging
app.use(
  morgan(config.isDev ? 'dev' : 'combined', {
    stream: {
      write: (msg) => {
        process.stdout.write(msg);
      },
    },
  })
);

// API routes
app.use('/api', routes);

// 404 + error handling
app.use(notFound);
app.use(errorHandler);

module.exports = app;
EOF

#######################################
# server.js
#######################################
cat > src/server.js <<'EOF'
const http = require('http');
const app = require('./app');
const config = require('./config/env');
const { initDatabase } = require('./config/database');

const server = http.createServer(app);

async function start() {
  try {
    await initDatabase();

    server.listen(config.port, () => {
      console.log(
        `[STARTUP] Server listening on http://localhost:${config.port} in ${config.env} mode`
      );
    });
  } catch (err) {
    console.error('[STARTUP] error:', err);
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  process.exit(1);
});

start();
EOF

echo "[INFO] Backend skeleton created."
echo "[INFO] Next steps:"
echo "  1) Ensure your .env has DATABASE_URL, PORT, JWT secrets set."
echo "  2) Install dependencies: npm install"
echo "  3) Run in dev mode:      npm run dev"
echo "  4) Test health:          curl -i http://localhost:3000/api/health"
EOF

