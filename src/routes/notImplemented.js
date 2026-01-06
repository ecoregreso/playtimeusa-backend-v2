// src/routes/notImplemented.js
const fs = require("fs");
const path = require("path");
const express = require("express");
const yaml = require("yaml");

const OPENAPI_PATH = path.resolve(__dirname, "..", "..", "docs", "openapi.yaml");

function toExpressPath(openapiPath) {
  return openapiPath.replace(/\{([^}]+)\}/g, ":$1");
}

function notImplementedHandler(req, res) {
  return res.status(501).json({
    ok: false,
    error: {
      code: "NOT_IMPLEMENTED",
      message: "Not implemented",
      details: {
        method: req.method,
        path: req.originalUrl,
      },
    },
  });
}

function buildNotImplementedRouter() {
  const router = express.Router();

  if (!fs.existsSync(OPENAPI_PATH)) {
    return router;
  }

  let spec;
  try {
    spec = yaml.parse(fs.readFileSync(OPENAPI_PATH, "utf8"));
  } catch (err) {
    console.warn("[NOT_IMPLEMENTED] failed to parse openapi.yaml:", err.message);
    return router;
  }

  const paths = spec?.paths || {};
  const methods = new Set(["get", "post", "put", "delete", "patch", "options", "head"]);

  for (const [openapiPath, ops] of Object.entries(paths)) {
    const expressPath = toExpressPath(openapiPath);
    for (const [method, op] of Object.entries(ops || {})) {
      if (!methods.has(method)) continue;
      if (op && op["x-ignore"]) continue;
      router[method](expressPath, notImplementedHandler);
    }
  }

  return router;
}

module.exports = { buildNotImplementedRouter };
