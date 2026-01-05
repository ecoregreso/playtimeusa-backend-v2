// src/utils/ownerSettings.js
const { OwnerSetting } = require("../models");

function safeParseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

async function getSetting(key) {
  const row = await OwnerSetting.findByPk(key);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  await OwnerSetting.upsert({ key, value: value == null ? null : String(value) });
}

async function getJson(key, fallback = null) {
  const raw = await getSetting(key);
  return safeParseJson(raw, fallback);
}

async function setJson(key, obj) {
  await setSetting(key, JSON.stringify(obj));
  return obj;
}

module.exports = {
  safeParseJson,
  getSetting,
  setSetting,
  getJson,
  setJson,
};
