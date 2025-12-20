#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing dependency: $1" >&2; exit 1; }; }
need node

echo "== Patch: src/routes/vouchers.js (creator fields inside Voucher.create) =="

node - <<'NODE'
const fs = require("fs");

const file = "src/routes/vouchers.js";
let s = fs.readFileSync(file, "utf8");

// Ensure helper exists
if (!s.includes("function getActor(req)")) {
  const anchor = "const router = express.Router();\n";
  if (!s.includes(anchor)) throw new Error("Could not find router anchor");
  s = s.replace(anchor, anchor + `
function getActor(req) {
  const actor = (req && (req.user || req.staff)) || {};
  const actorType =
    actor.actorType ||
    actor.actor_type ||
    (req && req.staff ? "staff" : "user");
  return { actor, actorType };
}
`);
  console.log("[patch] Added getActor(req) helper.");
} else {
  console.log("[patch] getActor(req) already present.");
}

// Find the Voucher.create({ ... }) block for voucher creation
const startNeedle = "const voucher = await Voucher.create({";
const start = s.indexOf(startNeedle);
if (start === -1) throw new Error("Could not find: " + startNeedle);

// Walk forward to find the matching end of the object literal `});`
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
if (brace !== 0) throw new Error("Unbalanced braces while parsing Voucher.create object.");

const objStart = start + startNeedle.length;
const objEnd = i; // points at the closing "}" of the object
let obj = s.slice(objStart, objEnd);

// Remove any existing creator fields inside this create object
obj = obj
  .split("\n")
  .filter(line => {
    const t = line.trim();
    if (/^createdBy(User|Staff)Id\s*:/.test(t)) return false;
    if (/^createdByActorType\s*:/.test(t)) return false;
    return true;
  })
  .join("\n");

// Insert creator fields near the end (right before the closing brace)
obj = obj.replace(/\s*$/, "\n\n      // creator audit: staff vs user\n      createdByActorType: getActor(req).actorType,\n      createdByUserId: getActor(req).actorType === \"staff\" ? null : getActor(req).actor.id,\n      createdByStaffId: getActor(req).actorType === \"staff\" ? Number(getActor(req).actor.id) : null,\n");

// Rebuild file
s = s.slice(0, objStart) + obj + s.slice(objEnd);

// Basic sanity check so we don’t silently brick the file
if (!s.includes("createdByActorType: getActor(req).actorType")) {
  throw new Error("Patch sanity check failed (creator fields not present).");
}

fs.writeFileSync(file, s, "utf8");
console.log("[patch] Patched Voucher.create() creator fields successfully.");
NODE

echo
echo "Done. In your nodemon terminal, type: rs"
