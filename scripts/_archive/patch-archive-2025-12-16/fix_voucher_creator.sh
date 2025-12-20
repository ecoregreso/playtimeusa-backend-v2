#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

PSQL="psql"
if [[ -x /usr/bin/psql ]]; then PSQL="/usr/bin/psql"; fi
echo "Using psql: $PSQL"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing dependency: $1" >&2; exit 1; }; }
need node
need "$PSQL"

export DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)"
: "${DATABASE_URL:?DATABASE_URL missing in .env}"
export PGSSLMODE="${PGSSLMODE:-require}"

echo "== DB: ensure voucher creator columns exist (idempotent) =="
"$PSQL" "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='vouchers' AND column_name='createdByActorType'
  ) THEN
    ALTER TABLE "vouchers" ADD COLUMN "createdByActorType" TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='vouchers' AND column_name='createdByStaffId'
  ) THEN
    ALTER TABLE "vouchers" ADD COLUMN "createdByStaffId" INTEGER;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='vouchers' AND column_name='createdByUserId'
  ) THEN
    ALTER TABLE "vouchers" ADD COLUMN "createdByUserId" UUID;
  END IF;
END $$;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name='vouchers'
  AND column_name IN ('createdByActorType','createdByStaffId','createdByUserId')
ORDER BY column_name;
SQL

echo
echo "== Code: patch src/routes/vouchers.js to write creator fields correctly =="
node - <<'NODE'
const fs = require("fs");

const f = "src/routes/vouchers.js";
let s = fs.readFileSync(f, "utf8");

if (!s.includes("function creatorFields(req)")) {
  const anchor = "const router = express.Router();";
  if (!s.includes(anchor)) throw new Error("Anchor not found: const router = express.Router();");

  const helper = `
function creatorFields(req) {
  // Staff JWTs often have sub like "1" (numeric), while user UUIDs are... UUIDs.
  const u = req.user || {};
  const id = u.id;
  const role = u.role || "";
  const actorType = u.actorType || (req.staff ? "staff" : "user");

  const isNumeric = (typeof id === "number") || (typeof id === "string" && /^[0-9]+$/.test(id));
  const isStaff = actorType === "staff" || !!req.staff || (isNumeric && role && role !== "player");

  if (isStaff) {
    const staffId = Number(isNumeric ? id : (req.staff && req.staff.id));
    return {
      createdByActorType: "staff",
      createdByStaffId: Number.isFinite(staffId) ? staffId : null,
    };
  }

  return {
    createdByActorType: "user",
    createdByUserId: id,
  };
}
`;
  s = s.replace(anchor, anchor + "\n" + helper);
  console.log("[patch] Added creatorFields(req) helper.");
} else {
  console.log("[patch] creatorFields(req) already present.");
}

// Replace createdByUserId: req.user.id with spread of creatorFields(req)
if (s.includes("...creatorFields(req)")) {
  console.log("[patch] Voucher.create already uses creatorFields(req); skipping replace.");
} else {
  const re = /createdByUserId\s*:\s*req\.user\.id\s*,?\s*\n/;
  if (!re.test(s)) throw new Error("Could not find createdByUserId: req.user.id in vouchers.js");
  s = s.replace(re, "        ...creatorFields(req),\n");
  console.log("[patch] Replaced createdByUserId with ...creatorFields(req).");
}

fs.writeFileSync(f, s, "utf8");
console.log("[done] vouchers.js patched.");
NODE

echo
echo "Done. If nodemon is running it should auto-restart."
