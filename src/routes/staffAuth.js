// src/routes/staffAuth.js
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { sequelize } = require("../models");

const router = express.Router();

const STAFF_JWT_SECRET = process.env.STAFF_JWT_SECRET || "dev-staff-secret";
const STAFF_JWT_EXPIRES_IN = process.env.STAFF_JWT_EXPIRES_IN || "8h";

function normalizePermissions(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// POST /api/v1/staff/login
router.post("/login", async (req, res) => {
  const body = req.body || {};
  const username = body.username || null;
  const email = body.email || null;
  const password = body.password || null;

  // Allow login by username OR email (but your table only has username today)
  if (!password || (!username && !email)) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing username/email or password" });
  }

  const identifier = username || email;

  try {
    // Use username column; if you later add email, you can expand WHERE
    const [rows] = await sequelize.query(
      `SELECT id,
              username,
              "passwordHash",
              role,
              "isActive",
              permissions
       FROM staff_users
       WHERE username = $1
       LIMIT 1`,
      { bind: [identifier] }
    );

    if (!rows || rows.length === 0) {
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    const row = rows[0];

    if (!row.isActive) {
      return res
        .status(403)
        .json({ ok: false, error: "Staff user inactive" });
    }

    const passwordMatch = await bcrypt.compare(password, row.passwordHash);
    if (!passwordMatch) {
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    const permissions = normalizePermissions(row.permissions);

    const payload = {
      sub: row.id,
      type: "staff",
      role: row.role,
      permissions,
    };

    const token = jwt.sign(payload, STAFF_JWT_SECRET, {
      expiresIn: STAFF_JWT_EXPIRES_IN,
    });

    return res.json({
      ok: true,
      token,
      staff: {
        id: row.id,
        username: row.username,
        role: row.role,
        isActive: row.isActive,
        permissions,
      },
    });
  } catch (err) {
    console.error("[STAFF_LOGIN] error:", err);
    return res.status(500).json({ ok: false, error: "Internal error" });
  }
});

// GET /api/v1/staff/me
router.get("/me", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ ok: false, error: "Missing Authorization header" });
  }

  const token = auth.slice(7);

  let payload;
  try {
    payload = jwt.verify(token, STAFF_JWT_SECRET);
  } catch (err) {
    console.error("[STAFF_ME] token error:", err.message);
    return res.status(401).json({ ok: false, error: "Invalid or expired token" });
  }

  if (payload.type !== "staff") {
    return res.status(403).json({ ok: false, error: "Not a staff token" });
  }

  try {
    const [rows] = await sequelize.query(
      `SELECT id,
              username,
              role,
              "isActive",
              permissions
       FROM staff_users
       WHERE id = $1
       LIMIT 1`,
      { bind: [payload.sub] }
    );

    if (!rows || rows.length === 0) {
      return res
        .status(404)
        .json({ ok: false, error: "Staff user not found" });
    }

    const row = rows[0];
    const permissions = normalizePermissions(row.permissions);

    return res.json({
      ok: true,
      staff: {
        id: row.id,
        username: row.username,
        role: row.role,
        isActive: row.isActive,
        permissions,
      },
    });
  } catch (err) {
    console.error("[STAFF_ME] DB error:", err);
    return res.status(500).json({ ok: false, error: "Internal error" });
  }
});

module.exports = router;
