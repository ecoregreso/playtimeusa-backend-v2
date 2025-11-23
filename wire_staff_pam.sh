#!/usr/bin/env bash
set -euo pipefail

# Resolve project root to where this script lives
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ROUTES_DIR="$PROJECT_ROOT/src/routes"
ROUTES_INDEX="$ROUTES_DIR/index.js"
STAFF_ROUTES="$ROUTES_DIR/staffRoutes.js"

echo "Project root: $PROJECT_ROOT"

if [ ! -f "$ROUTES_INDEX" ]; then
  echo "ERROR: Cannot find $ROUTES_INDEX"
  echo "Run this from your backend-v2 root where src/routes/index.js exists."
  exit 1
fi

echo "✅ Found routes index: $ROUTES_INDEX"

# 1) Ensure staffRoutes.js exists (minimal stub if missing)
if [ ! -f "$STAFF_ROUTES" ]; then
  echo "📄 Creating $STAFF_ROUTES ..."
  cat > "$STAFF_ROUTES" <<'EOF'
// src/routes/staffRoutes.js
const express = require('express');
const router = express.Router();

// TODO: replace this with real PAM / staff logic.
// This is just a sanity check endpoint for now.
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    scope: 'staff',
    message: 'Staff routes wired up and reachable.'
  });
});

module.exports = router;
EOF
else
  echo "ℹ️ $STAFF_ROUTES already exists, leaving it untouched."
fi

# 2) Patch src/routes/index.js to require & mount staffRoutes
echo "🔧 Patching routes/index.js ..."

PROJECT_ROOT_JS="$PROJECT_ROOT" node <<'EOF'
const fs = require('fs');
const path = require('path');

const root = process.env.PROJECT_ROOT_JS || process.cwd();
const routesIndex = path.join(root, 'src', 'routes', 'index.js');

let src = fs.readFileSync(routesIndex, 'utf8');
let changed = false;

// Add require('./staffRoutes') if missing
if (!src.includes("staffRoutes")) {
  const requirePattern = /const\s+adminRoutes\s*=\s*require\('\.\/adminRoutes'\);\s*/;
  if (requirePattern.test(src)) {
    src = src.replace(
      requirePattern,
      match => match + "const staffRoutes = require('./staffRoutes');\n"
    );
    console.log("➕ Added const staffRoutes = require('./staffRoutes');");
    changed = true;
  } else {
    console.warn("⚠️ Could not find adminRoutes require line to anchor staffRoutes require.");
  }
}

// Add router.use('/staff', staffRoutes) if missing
if (!src.includes("router.use('/staff'")) {
  const usePattern = /router\.use\('\/admin',\s*adminRoutes\);\s*/;
  if (usePattern.test(src)) {
    src = src.replace(
      usePattern,
      match => match + "router.use('/staff', staffRoutes);\n"
    );
    console.log("➕ Added router.use('/staff', staffRoutes);");
    changed = true;
  } else {
    console.warn("⚠️ Could not find router.use('/admin', adminRoutes); to anchor staffRoutes mount.");
  }
}

if (changed) {
  fs.writeFileSync(routesIndex, src);
  console.log("✅ routes/index.js updated.");
} else {
  console.log("ℹ️ No changes needed in routes/index.js (staff already wired?).");
}
EOF

echo "✅ Wiring complete."
echo "Now restart your backend and test:"
echo "  GET /api/v1/staff/health"
