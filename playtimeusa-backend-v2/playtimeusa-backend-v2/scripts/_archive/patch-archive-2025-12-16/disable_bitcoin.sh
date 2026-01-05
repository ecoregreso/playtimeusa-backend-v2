#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

FILE="src/server.js"
test -f "$FILE" || { echo "Missing $FILE"; exit 1; }

node - <<'NODE'
const fs = require("fs");

const file = "src/server.js";
let s = fs.readFileSync(file, "utf8");

if (s.includes("ENABLE_BITCOIN")) {
  console.log("[patch] ENABLE_BITCOIN already present; skipping.");
  process.exit(0);
}

// 1) Remove existing unconditional requires (if present)
s = s.replace(/^const\s+depositsRoutes\s*=\s*require\(["']\.\/routes\/deposits["']\);\s*\n/m, "");
s = s.replace(/^const\s+withdrawalsRoutes\s*=\s*require\(["']\.\/routes\/withdrawals["']\);\s*\n/m, "");

// 2) Insert feature flag + conditional requires after other route requires.
// We anchor right after staff/admin route requires which you already have.
const anchor = /const\s+adminStaffRoutes\s*=\s*require\(["']\.\/routes\/adminStaff["']\);\s*\n/m;
if (!anchor.test(s)) {
  console.error("[patch] Could not find adminStaffRoutes require anchor in server.js");
  process.exit(1);
}

s = s.replace(anchor, (m) => {
  return (
    m +
`
// --- Feature flag: Bitcoin (deposits/withdrawals) ---
const ENABLE_BITCOIN = process.env.ENABLE_BITCOIN === "1";
let depositsRoutes = null;
let withdrawalsRoutes = null;
if (ENABLE_BITCOIN) {
  depositsRoutes = require("./routes/deposits");
  withdrawalsRoutes = require("./routes/withdrawals");
}
`
  );
});

// 3) Replace mounts with conditional mounts
s = s.replace(
  /^app\.use\(["']\/api\/v1\/deposits["'],\s*depositsRoutes\);\s*\n/m,
  `if (ENABLE_BITCOIN) app.use("/api/v1/deposits", depositsRoutes);\n`
);

s = s.replace(
  /^app\.use\(["']\/api\/v1\/withdrawals["'],\s*withdrawalsRoutes\);\s*\n/m,
  `if (ENABLE_BITCOIN) app.use("/api/v1/withdrawals", withdrawalsRoutes);\n`
);

// If withdrawals mount exists but under different ordering, try a looser replace:
s = s.replace(/app\.use\(["']\/api\/v1\/deposits["'][^\n]*\n/g, (line) => {
  if (line.includes("ENABLE_BITCOIN")) return line;
  return `if (ENABLE_BITCOIN) ${line.trim()}\n`;
});
s = s.replace(/app\.use\(["']\/api\/v1\/withdrawals["'][^\n]*\n/g, (line) => {
  if (line.includes("ENABLE_BITCOIN")) return line;
  return `if (ENABLE_BITCOIN) ${line.trim()}\n`;
});

fs.writeFileSync(file, s, "utf8");
console.log("[patch] Bitcoin routes are now feature-flagged behind ENABLE_BITCOIN=1");
NODE
