const express = require("express");
const { OwnerSetting } = require("../models");

const router = express.Router();

const parseBrandValue = (value) => {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
};

const resolveBrand = async () => {
  const fromEnv = parseBrandValue(process.env.BRAND_JSON);
  if (fromEnv) return fromEnv;
  const row = await OwnerSetting.findByPk("brand");
  return parseBrandValue(row?.value);
};

router.get("/brand", async (req, res) => {
  try {
    const brand = await resolveBrand();
    res.json({ brand: brand || null });
  } catch (err) {
    res.json({ brand: null });
  }
});

module.exports = router;
