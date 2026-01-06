const fs = require("fs");
const path = require("path");
const yaml = require("yaml");

const OPENAPI_PATH = path.resolve(__dirname, "..", "..", "docs", "openapi.yaml");
const SERVER_PATH = path.resolve(__dirname, "..", "..", "src", "server.js");

const METHODS = new Set(["get", "post", "put", "delete", "patch", "options", "head"]);

function normalizePath(value) {
  if (!value) return "/";
  let out = String(value);
  out = out.replace(/\/+/g, "/");
  if (!out.startsWith("/")) out = `/${out}`;
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function joinPaths(prefix, suffix) {
  const left = prefix && prefix !== "/" ? prefix : "";
  const right = suffix && suffix !== "/" ? suffix : "";
  const combined = `${left}${right}` || "/";
  return normalizePath(combined);
}

function openapiToExpressPath(openapiPath) {
  const replaced = String(openapiPath || "").replace(/\{([^}]+)\}/g, ":$1");
  return normalizePath(`/api/v1${replaced.startsWith("/") ? replaced : `/${replaced}`}`);
}

function layerRegexpToPath(layer) {
  if (!layer?.regexp) return "";
  if (layer.regexp.fast_slash) return "";

  let pathValue = layer.regexp.source || "";
  pathValue = pathValue.replace(/\\\//g, "/");
  pathValue = pathValue.replace(/\(\?=\/\|\$\)/g, "");
  pathValue = pathValue.replace(/\(\?=\\\/\|\$\)/g, "");
  pathValue = pathValue.replace(/\\\?/g, "");
  pathValue = pathValue.replace(/\?/g, "");
  pathValue = pathValue.replace(/^\^/, "");
  pathValue = pathValue.replace(/\$$/, "");

  if (!pathValue) return "";

  if (layer.keys && layer.keys.length) {
    let index = 0;
    pathValue = pathValue.replace(/\(\?:\(\[\^\/]\+\?\)\)/g, () => {
      const key = layer.keys[index++];
      return key?.name ? `:${key.name}` : ":param";
    });
    pathValue = pathValue.replace(/\(\[\^\/]\+\?\)/g, () => {
      const key = layer.keys[index++];
      return key?.name ? `:${key.name}` : ":param";
    });
  }

  return normalizePath(pathValue);
}

function collectRoutesFromStack(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route && layer.route.path) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      const methods = Object.keys(layer.route.methods || {}).filter(
        (method) => layer.route.methods[method]
      );
      for (const routePath of paths) {
        if (routePath instanceof RegExp) continue;
        const fullPath = joinPaths(prefix, routePath);
        for (const method of methods) {
          out.push({ method: method.toUpperCase(), path: normalizePath(fullPath) });
        }
      }
      continue;
    }

    if (layer.name === "router" && layer.handle?.stack) {
      const layerPath = layerRegexpToPath(layer);
      collectRoutesFromStack(layer.handle.stack, joinPaths(prefix, layerPath), out);
    }
  }
}

function listRoutes(app) {
  const routes = [];
  collectRoutesFromStack(app._router?.stack || [], "", routes);
  return routes;
}

function main() {
  if (!fs.existsSync(OPENAPI_PATH)) {
    console.error(`[contract] missing ${OPENAPI_PATH}`);
    process.exit(1);
  }

  const spec = yaml.parse(fs.readFileSync(OPENAPI_PATH, "utf8"));
  const paths = spec?.paths || {};

  const expected = [];
  for (const [openapiPath, ops] of Object.entries(paths)) {
    for (const method of Object.keys(ops || {})) {
      if (!METHODS.has(method)) continue;
      expected.push({
        method: method.toUpperCase(),
        path: openapiToExpressPath(openapiPath),
      });
    }
  }

  process.env.NODE_ENV = "test";
  const app = require(SERVER_PATH);
  const actualRoutes = listRoutes(app);
  const actualSet = new Set(actualRoutes.map((r) => `${r.method} ${r.path}`));

  const missing = [];
  const hints = [];

  for (const entry of expected) {
    const key = `${entry.method} ${entry.path}`;
    if (actualSet.has(key)) continue;
    missing.push(entry);

    const altKey = `${entry.method} ${normalizePath(entry.path.replace("/api/v1", "/api"))}`;
    if (actualSet.has(altKey)) {
      hints.push(`${entry.method} ${entry.path} found under /api instead of /api/v1`);
    }
  }

  if (missing.length) {
    console.error("[contract] missing routes:");
    for (const entry of missing) {
      console.error(`- ${entry.method} ${entry.path}`);
    }
    if (hints.length) {
      console.error("[contract] hints:");
      for (const hint of hints) console.error(`- ${hint}`);
    }
    process.exit(1);
  }

  console.log(`[contract] OK (${expected.length} routes)`);
  process.exit(0);
}

main();
