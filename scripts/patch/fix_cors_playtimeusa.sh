#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

FILE="src/server.js"
if [[ ! -f "$FILE" ]]; then
  echo "ERROR: $FILE not found. Run this from the backend repo root." >&2
  exit 1
fi

echo "[patch] backing up $FILE -> $FILE.bak"
cp -f "$FILE" "$FILE.bak"

# Ensure cors is required
if ! grep -qE "const\s+cors\s*=\s*require\(['\"]cors['\"]\)" "$FILE"; then
  echo "[patch] adding cors require"
  # insert after express require (best effort)
  perl -i -pe 'if($.==1){$seen=0} if(!$seen && /require\([\"\x27]express[\"\x27]\)/){$seen=1; $_ .= "const cors = require(\"cors\");\n";} ' "$FILE"
fi

# Replace the existing app.use(cors({ ... })) block under the "// CORS" comment
# with hardened corsOptions + explicit preflight handler.
perl -0777 -i -pe 's|
  //\s*CORS\s*\n
  \s*app\.use\(\s*cors\(\s*\{.*?\}\s*\)\s*\);\s*\n
|
  // CORS\n
  const corsOptions = {\n
    origin: (origin, cb) => {\n
      // No origin usually means server-to-server, curl, postman\n
      if (!origin) return cb(null, true);\n
\n
      if (ALLOW_ALL_ORIGINS) return cb(null, true);\n
\n
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);\n
\n
      return cb(new Error(`Not allowed by CORS: ${origin}`));\n
    },\n
    credentials: true,\n
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],\n
    allowedHeaders: ["Content-Type", "Authorization"],\n
    maxAge: 86400,\n
  };\n
\n
  app.use(cors(corsOptions));\n
  app.options("*", cors(corsOptions));\n
\n
|gmsx' "$FILE"

# If the pattern didn't match (maybe comment/block differs), we do a fallback:
# add corsOptions + app.options right after first app.use(cors(...)) occurrence.
if ! grep -q "app.options(\"\\*\", cors(corsOptions))" "$FILE"; then
  echo "[patch] fallback insert (could not replace CORS block by pattern)"
  perl -0777 -i -pe 's|
    app\.use\(\s*cors\((.*?)\)\s*\);\s*
  |
    const corsOptions = {\n
      origin: (origin, cb) => {\n
        if (!origin) return cb(null, true);\n
        if (ALLOW_ALL_ORIGINS) return cb(null, true);\n
        if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);\n
        return cb(new Error(`Not allowed by CORS: ${origin}`));\n
      },\n
      credentials: true,\n
      methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],\n
      allowedHeaders: ["Content-Type","Authorization"],\n
      maxAge: 86400,\n
    };\n
\n
    app.use(cors(corsOptions));\n
    app.options("*", cors(corsOptions));\n
  |msx' "$FILE"
fi

# Sanity check
echo "[patch] verifying..."
grep -n "const corsOptions" "$FILE" >/dev/null || { echo "ERROR: corsOptions missing after patch." >&2; exit 1; }
grep -n "app.options(\"\\*\", cors(corsOptions))" "$FILE" >/dev/null || { echo "ERROR: preflight handler missing after patch." >&2; exit 1; }

echo "[patch] ✅ done"
echo
echo "NEXT (Render env): set CORS_ORIGINS to:"
echo "  https://playtimeusa.net,https://www.playtimeusa.net"
echo
echo "Verify preflight after deploy:"
echo "curl -i -X OPTIONS \"https://playtimeusa-backend-v2.onrender.com/api/v1/player/login\" \\"
echo "  -H \"Origin: https://playtimeusa.net\" \\"
echo "  -H \"Access-Control-Request-Method: POST\" \\"
echo "  -H \"Access-Control-Request-Headers: content-type\""
