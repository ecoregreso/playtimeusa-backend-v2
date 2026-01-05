#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing dependency: $1" >&2; exit 1; }; }
need node
need psql

mkdir -p migrations
MIG="migrations/004_voucher_creator_audit.sql"
if [[ ! -f "$MIG" ]]; then
  cat > "$MIG" <<'SQL'
-- 004_voucher_creator_audit.sql
-- Adds creator audit columns for vouchers (idempotent) + indexes

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vouchers' AND column_name='createdByActorType') THEN
    ALTER TABLE "vouchers" ADD COLUMN "createdByActorType" TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vouchers' AND column_name='createdByStaffId') THEN
    ALTER TABLE "vouchers" ADD COLUMN "createdByStaffId" INTEGER;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vouchers' AND column_name='createdByUserId') THEN
    ALTER TABLE "vouchers" ADD COLUMN "createdByUserId" UUID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS vouchers_created_by_actor_type_idx ON vouchers ("createdByActorType");
CREATE INDEX IF NOT EXISTS vouchers_created_by_staff_id_idx ON vouchers ("createdByStaffId");
CREATE INDEX IF NOT EXISTS vouchers_created_by_user_id_idx ON vouchers ("createdByUserId");
SQL
  echo "[migrations] created $MIG"
else
  echo "[migrations] exists: $MIG"
fi

echo "== Patch: unify Sequelize instance in models (stop using src/db.js) =="
node - <<'NODE'
const fs = require("fs");

const files = [
  "src/models/Wallet.js",
  "src/models/Transaction.js",
  "src/models/GameRound.js",
  "src/models/Voucher.js",
];

function backup(p, s) {
  const ts = Math.floor(Date.now() / 1000);
  fs.writeFileSync(`${p}.bak.${ts}`, s, "utf8");
}

for (const f of files) {
  if (!fs.existsSync(f)) { console.log(`[skip] missing ${f}`); continue; }
  const orig = fs.readFileSync(f, "utf8");
  let s = orig;

  s = s.replace(/require\((['"])\.\.\/db\1\)/g, 'require("../config/database")');

  if (s !== orig) {
    backup(f, orig);
    fs.writeFileSync(f, s, "utf8");
    console.log(`[patch] ${f}: ../db -> ../config/database`);
  } else {
    console.log(`[ok]   ${f}: already using config/database (or no change needed)`);
  }
}
NODE

echo "== Patch: src/models/Voucher.js (add audit fields; keep metadata as JSON) =="
node - <<'NODE'
const fs = require("fs");

const f = "src/models/Voucher.js";
if (!fs.existsSync(f)) throw new Error("Missing " + f);

const orig = fs.readFileSync(f, "utf8");
const ts = Math.floor(Date.now() / 1000);
fs.writeFileSync(`${f}.bak.${ts}`, orig, "utf8");

const next = `// src/models/Voucher.js
const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/database");
const User = require("./User");

const Voucher = sequelize.define(
  "Voucher",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    code: {
      type: DataTypes.STRING(32),
      allowNull: false,
      unique: true,
    },
    pin: {
      type: DataTypes.STRING(16),
      allowNull: false,
    },
    amount: {
      type: DataTypes.DECIMAL(18, 4),
      allowNull: false,
    },
    bonusAmount: {
      type: DataTypes.DECIMAL(18, 4),
      allowNull: false,
      defaultValue: 0,
    },
    currency: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: "FUN",
    },
    status: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: "new", // new | redeemed | cancelled | expired
    },
    redeemedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    // Creator audit
    createdByActorType: {
      type: DataTypes.STRING(16),
      allowNull: true,
    },
    createdByStaffId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    createdByUserId: {
      type: DataTypes.UUID,
      allowNull: true,
    },

    redeemedByUserId: {
      type: DataTypes.UUID,
      allowNull: true,
    },

    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  },
  {
    tableName: "vouchers",
    timestamps: true,
  }
);

// created-by user
User.hasMany(Voucher, { foreignKey: { name: "createdByUserId", allowNull: true } });
Voucher.belongsTo(User, { as: "createdBy", foreignKey: { name: "createdByUserId", allowNull: true } });

// redeemed-by user
User.hasMany(Voucher, { foreignKey: { name: "redeemedByUserId", allowNull: true } });
Voucher.belongsTo(User, { as: "redeemedBy", foreignKey: { name: "redeemedByUserId", allowNull: true } });

module.exports = Voucher;
`;

fs.writeFileSync(f, next, "utf8");
console.log("[patch] rewrote src/models/Voucher.js (backup created).");
NODE

echo "== Patch: src/routes/vouchers.js (use ...creatorFields(req) exactly once) =="
node - <<'NODE'
const fs = require("fs");

const f = "src/routes/vouchers.js";
let s = fs.readFileSync(f, "utf8");
const orig = s;

// Ensure creatorFields(req)
if (!s.includes("function creatorFields(req)")) {
  const anchor = "const router = express.Router();";
  if (!s.includes(anchor)) throw new Error("Anchor not found: " + anchor);

  const helper = `
function creatorFields(req) {
  const u = (req && req.user) || {};
  const actorType = u.actorType || "user";
  const id = u.id || null;

  if (actorType === "staff") {
    const staffId = Number(id);
    return {
      createdByActorType: "staff",
      createdByStaffId: Number.isFinite(staffId) ? staffId : null,
      createdByUserId: null,
    };
  }

  return {
    createdByActorType: "user",
    createdByStaffId: null,
    createdByUserId: id,
  };
}
`;
  s = s.replace(anchor, anchor + "\n" + helper);
  console.log("[patch] Added creatorFields(req) helper.");
} else {
  console.log("[ok] creatorFields(req) already present.");
}

// Patch Voucher.create({...})
const startNeedle = "const voucher = await Voucher.create({";
const start = s.indexOf(startNeedle);
if (start === -1) throw new Error("Could not find: " + startNeedle);

let i = start + startNeedle.length;
let brace = 1;
let inStr = null;
let esc = false;

for (; i < s.length; i++) {
  const ch = s[i];
  if (esc) { esc = false; continue; }
  if (ch === "\\") { esc = true; continue; }

  if (inStr) {
    if (ch === inStr) inStr = null;
    continue;
  }
  if (ch === "'" || ch === '"' || ch === "`") { inStr = ch; continue; }

  if (ch === "{") brace++;
  if (ch === "}") brace--;
  if (brace === 0) break;
}
if (brace !== 0) throw new Error("Unbalanced braces in Voucher.create object.");

const objStart = start + startNeedle.length;
const objEnd = i;
let obj = s.slice(objStart, objEnd);

// Remove existing creator audit lines
obj = obj
  .split("\n")
  .filter(line => {
    const t = line.trim();
    if (t.includes("creator audit")) return false;
    if (/^createdByActorType\s*:/.test(t)) return false;
    if (/^createdByUserId\s*:/.test(t)) return false;
    if (/^createdByStaffId\s*:/.test(t)) return false;
    if (/^\.\.\.creatorFields\(req\)\s*,?/.test(t)) return false;
    return true;
  })
  .join("\n");

// Insert spread once (near the end)
obj = obj.replace(/\s*$/, "\n\n        // creator audit\n        ...creatorFields(req),\n");

s = s.slice(0, objStart) + obj + s.slice(objEnd);

if (!s.includes("...creatorFields(req)")) throw new Error("creatorFields spread not present after patch.");

if (s !== orig) {
  const ts = Math.floor(Date.now() / 1000);
  fs.writeFileSync(`${f}.bak.${ts}`, orig, "utf8");
  fs.writeFileSync(f, s, "utf8");
  console.log("[patch] vouchers.js patched (backup created).");
} else {
  console.log("[ok] vouchers.js already patched.");
}
NODE

echo
echo "== Apply migrations =="
./scripts/db/migrate.sh

echo
echo "Done. If nodemon is running, type: rs"
