const fs = require("fs");
const path = require("path");
const yaml = require("yaml");

const OPENAPI_PATH = path.resolve(__dirname, "..", "docs", "openapi.yaml");

function fail(message) {
  console.error(message);
  process.exit(1);
}

try {
  if (!fs.existsSync(OPENAPI_PATH)) {
    fail(`Missing OpenAPI file at ${OPENAPI_PATH}`);
  }

  const raw = fs.readFileSync(OPENAPI_PATH, "utf8");
  const doc = yaml.parse(raw);

  if (!doc || typeof doc !== "object") {
    fail("OpenAPI YAML did not parse to an object.");
  }
  if (!doc.openapi) {
    fail("OpenAPI spec missing 'openapi' field.");
  }
  if (!doc.paths || typeof doc.paths !== "object") {
    fail("OpenAPI spec missing 'paths' object.");
  }

  console.log(`OpenAPI lint OK: ${Object.keys(doc.paths).length} paths`);
} catch (err) {
  fail(`OpenAPI lint failed: ${err.message}`);
}
