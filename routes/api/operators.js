const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { extractRole } = require("../../utils/roleGuard");
const { requireSafeId } = require("../../utils/securityValidation");

const router = express.Router();
let ensureOperatorColumnsPromise = null;

function requireOperator(req, res) {
  const role = extractRole(req);
  if (role !== "operator") {
    res.status(403).json({ message: "Akses ditolak. Role operator diperlukan." });
    return false;
  }
  return true;
}

async function ensureOperatorColumns() {
  if (!ensureOperatorColumnsPromise) {
    ensureOperatorColumnsPromise = (async () => {
      await query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS username TEXT,
        ADD COLUMN IF NOT EXISTS phone TEXT
      `);
      await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_unique
        ON users (username)
        WHERE username IS NOT NULL
      `);
    })();
  }
  await ensureOperatorColumnsPromise;
}

function normalizeText(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

function normalizeStatus(value) {
  if (value == null || value === "") return null;
  const normalized = String(value).trim();
  if (!["Aktif", "Nonaktif"].includes(normalized)) {
    const error = new Error('status harus "Aktif" atau "Nonaktif".');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function mapOperator(row) {
  return {
    id: row.id,
    name: row.name,
    initials: row.initials,
    email: row.email,
    username: row.username,
    phone: row.phone,
    status: row.is_active ? "Aktif" : "Nonaktif",
    role: row.role,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toInitials(name) {
  return String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "OP";
}

function handleUniqueError(error, res) {
  if (error?.code !== "23505") return false;
  const constraint = String(error.constraint || "");
  if (constraint.includes("email")) {
    res.status(409).json({ message: "Email sudah digunakan." });
    return true;
  }
  if (constraint.includes("username")) {
    res.status(409).json({ message: "Username sudah digunakan." });
    return true;
  }
  res.status(409).json({ message: "Data operator duplikat." });
  return true;
}

router.get(
  "/",
  asyncHandler(async (_req, res) => {
    await ensureOperatorColumns();
    const result = await query(
      `
      SELECT id, name, initials, email, username, phone, is_active, role, created_at, updated_at
      FROM users
      WHERE role = 'operator'
      ORDER BY name ASC
      `
    );

    return res.json(result.rows.map(mapOperator));
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireOperator(req, res)) return;
    await ensureOperatorColumns();
    const operatorId = requireSafeId(req.params.id, "id");

    const {
      name,
      initials,
      email,
      username,
      phone,
      password,
      status = "Aktif",
      role,
    } = req.body || {};

    if (role !== "operator") {
      return res.status(400).json({ message: 'role wajib bernilai "operator".' });
    }
    if (!normalizeText(name) || !normalizeText(email) || !normalizeText(password)) {
      return res.status(400).json({ message: "name, email, dan password wajib diisi." });
    }

    const normalizedStatus = normalizeStatus(status) || "Aktif";
    const passwordHash = await bcrypt.hash(String(password), 10);
    const id = `usr_op_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    try {
      const result = await query(
        `
        INSERT INTO users (id, name, initials, role, email, username, phone, password_hash, is_active)
        VALUES ($1, $2, $3, 'operator', $4, $5, $6, $7, $8)
        RETURNING id, name, initials, email, username, phone, is_active, role, created_at, updated_at
        `,
        [
          id,
          normalizeText(name),
          normalizeText(initials) || toInitials(name),
          normalizeText(email),
          normalizeText(username),
          normalizeText(phone),
          passwordHash,
          normalizedStatus === "Aktif",
        ]
      );

      return res.status(201).json(mapOperator(result.rows[0]));
    } catch (error) {
      if (handleUniqueError(error, res)) return;
      throw error;
    }
  })
);

router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireOperator(req, res)) return;
    await ensureOperatorColumns();

    const body = req.body || {};
    const normalizedStatus = Object.prototype.hasOwnProperty.call(body, "status")
      ? normalizeStatus(body.status)
      : null;
    const passwordHash = normalizeText(body.password)
      ? await bcrypt.hash(String(body.password), 10)
      : null;

    try {
      const result = await query(
        `
        UPDATE users
        SET name = COALESCE($2, name),
            initials = COALESCE($3, initials),
            email = COALESCE($4, email),
            username = CASE WHEN $5::boolean THEN $6 ELSE username END,
            phone = CASE WHEN $7::boolean THEN $8 ELSE phone END,
            password_hash = COALESCE($9, password_hash),
            is_active = CASE WHEN $10::boolean THEN $11 ELSE is_active END,
            updated_at = NOW()
        WHERE id = $1 AND role = 'operator'
        RETURNING id, name, initials, email, username, phone, is_active, role, created_at, updated_at
        `,
        [
          operatorId,
          normalizeText(body.name),
          normalizeText(body.initials),
          normalizeText(body.email),
          Object.prototype.hasOwnProperty.call(body, "username"),
          normalizeText(body.username),
          Object.prototype.hasOwnProperty.call(body, "phone"),
          normalizeText(body.phone),
          passwordHash,
          Object.prototype.hasOwnProperty.call(body, "status"),
          normalizedStatus == null ? null : normalizedStatus === "Aktif",
        ]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ message: "Operator tidak ditemukan." });
      }

      return res.json(mapOperator(result.rows[0]));
    } catch (error) {
      if (handleUniqueError(error, res)) return;
      throw error;
    }
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireOperator(req, res)) return;
    await ensureOperatorColumns();
    const operatorId = requireSafeId(req.params.id, "id");

    const result = await query(
      "DELETE FROM users WHERE id = $1 AND role = 'operator' RETURNING id",
      [operatorId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Operator tidak ditemukan." });
    }

    return res.json({ message: "Data operator berhasil dihapus." });
  })
);

module.exports = router;
