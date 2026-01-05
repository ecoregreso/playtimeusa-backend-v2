#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

FILE="src/server.js"
test -f "$FILE" || { echo "Missing $FILE"; exit 1; }

node - <<'NODE'
const fs = require("fs");

const file = "src/server.js";
let s = fs.readFileSync(file, "utf8");

// Normalize some smashed declarations like `);const X` -> `);\nconst X`
s = s.replace(/\);\s*const\s+/g, ");\nconst ");
s = s.replace(/;\s*const\s+/g, ";\nconst ");

// 1) Remove any previous ENABLE_BITCOIN block (so we can re-add cleanly)
s = s.replace(
  /\/\/ --- Feature flag: Bitcoin \(deposits\/withdrawals\) ---[\s\S]*?\n\n/gm,
  "\n"
);

// 2) Remove any unconditional requires for deposits/withdrawals (even if on same line)
s = s.replace(/const\s+depositsRoutes\s*=\s*require\(["']\.\/routes\/deposits["']\);\s*/g, "");
s = s.replace(/const\s+withdrawalsRoutes\s*=\s*require\(["']\.\/routes\/withdrawals["']\);\s*/g, "");

// 3) Remove any existing mounts for deposits/withdrawals (conditional or not)
s = s.replace(/^\s*(if\s*\(\s*ENABLE_BITCOIN\s*\)\s*)?app\.use\(["']\/api\/v1\/deposits["'][^\n]*\n/gm, "");
s = s.replace(/^\s*(if\s*\(\s*ENABLE_BITCOIN\s*\)\s*)?app\.use\(["']\/api\/v1\/withdrawals["'][^\n]*\n/gm, "");

// 4) Insert clean feature-flag block after a stable require anchor
const anchors = [
  /const\s+adminStaffRoutes\s*=\s*require\(["']\.\/routes\/adminStaff["']\);\s*\n/m,
  /const\s+staffAuthRoutes\s*=\s*require\(["']\.\/routes\/staffAuth["']\);\s*\n/m,
  /const\s+adminPlayersRoutes\s*=\s*require\(["']\.\/routes\/adminPlayers["']\);\s*\n/m
];

let inserted = false;
for (const anchor of anchors) {
  if (anchor.test(s)) {
    s = s.replace(anchor, (m) => m + `
// --- Feature flag: Bitcoin (deposits/withdrawals) ---
const ENABLE_BITCOIN = process.env.ENABLE_BITCOIN === "1";
let depositsRoutes = null;
let withdrawalsRoutes = null;
if (ENABLE_BITCOIN) {
  depositsRoutes = require("./routes/deposits");
  withdrawalsRoutes = require("./routes/withdrawals");
}

`);
    inserted = true;
    break;
  }
}

if (!inserted) {
  throw new Error("[patch] Could not find a safe require anchor in src/server.js to insert ENABLE_BITCOIN block.");
}

// 5) Insert conditional mounts near the other route mounts
const mountAnchors = [
  /app\.use\(["']\/api\/v1\/admin\/staff["'],\s*adminStaffRoutes\);\s*\n/m,
  /app\.use\(["']\/api\/v1\/staff["'],\s*staffAuthRoutes\);\s*\n/m,
  /app\.use\(["']\/api\/v1\/vouchers["'],\s*voucherRoutes\);\s*\n/m
];

let mounted = false;
for (const ma of mountAnchors) {
  if (ma.test(s)) {
    s = s.replace(ma, (m) => m + `if (ENABLE_BITCOIN) app.use("/api/v1/deposits", depositsRoutes);
if (ENABLE_BITCOIN) app.use("/api/v1/withdrawals", withdrawalsRoutes);
`);
    mounted = true;
    break;
  }
}
if (!mounted) {
  throw new Error("[patch] Could not find a safe mount anchor in src/server.js to insert conditional deposit/withdraw mounts.");
}

fs.writeFileSync(file, s, "utf8");
console.log("[patch] Fixed duplicate declarations and feature-flagged bitcoin routes behind ENABLE_BITCOIN=1");
NODE

# Force flag OFF locally
if [ -f .env ]; then
  if grep -q '^ENABLE_BITCOIN=' .env; then
    sed -i 's/^ENABLE_BITCOIN=.*/ENABLE_BITCOIN=0/' .env
  else
    echo 'ENABLE_BITCOIN=0' >> .env
  fi
else
  echo 'ENABLE_BITCOIN=0' > .env
fi

echo "[ok] ENABLE_BITCOIN set to 0 in .env"
