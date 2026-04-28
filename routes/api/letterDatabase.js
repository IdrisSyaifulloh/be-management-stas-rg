const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { extractRole } = require("../../utils/roleGuard");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { requireSafeId } = require("../../utils/securityValidation");

const router = express.Router();
router.param("id", (req, res, next, value) => {
  try {
    req.params.id = requireSafeId(value, "id");
    next();
  } catch (error) {
    next(error);
  }
});
const LETTER_DATABASE_UPLOAD_DIR = path.join(__dirname, "../../public/uploads/letter-database");
const ALLOWED_FILE_TYPES = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "image/png": ".png",
  "image/jpeg": ".jpg"
};

let ensureTablePromise = null;

function resolveUserId(req) {
  return String(req.authUser?.id || req.headers["x-user-id"] || req.query.userId || req.body?.userId || "").trim() || null;
}

function requireOperator(req, res) {
  const role = extractRole(req);
  if (role !== "operator") {
    res.status(403).json({ message: "Hanya operator yang dapat mengelola database surat." });
    return false;
  }
  return true;
}

async function ensureLetterDatabaseTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = query(`
      CREATE TABLE IF NOT EXISTS letter_database (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'Lainnya',
        number TEXT,
        date DATE,
        description TEXT,
        file_url TEXT,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }
  await ensureTablePromise;
}

function sanitizeFilenameBase(name) {
  return String(name || "surat")
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "surat";
}

async function saveLetterDatabaseFile(fileDataUrl, originalFileName) {
  const match = String(fileDataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    const error = new Error("Format file tidak valid.");
    error.statusCode = 400;
    throw error;
  }

  const extension = ALLOWED_FILE_TYPES[match[1]];
  if (!extension) {
    const error = new Error("Tipe file harus PDF, DOC, DOCX, PNG, atau JPG.");
    error.statusCode = 400;
    throw error;
  }

  let buffer;
  try {
    buffer = Buffer.from(match[2], "base64");
  } catch {
    const error = new Error("File base64 tidak valid.");
    error.statusCode = 400;
    throw error;
  }

  if (!buffer || buffer.length === 0) {
    const error = new Error("File kosong tidak dapat diunggah.");
    error.statusCode = 400;
    throw error;
  }

  if (buffer.length > 4 * 1024 * 1024) {
    const error = new Error("Ukuran file maksimal 4 MB.");
    error.statusCode = 400;
    throw error;
  }

  await fs.mkdir(LETTER_DATABASE_UPLOAD_DIR, { recursive: true });
  const baseName = sanitizeFilenameBase(originalFileName);
  const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${baseName}${extension}`;
  await fs.writeFile(path.join(LETTER_DATABASE_UPLOAD_DIR, fileName), buffer);
  return `/uploads/letter-database/${fileName}`;
}

function mapLetterDatabaseRow(row) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    number: row.number,
    date: row.date_text || row.date,
    description: row.description,
    file_url: row.file_url,
    fileUrl: row.file_url,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

async function fetchLetterDatabaseItem(id) {
  const result = await query(
    `
    SELECT id, title, category, number, TO_CHAR(date, 'YYYY-MM-DD') AS date_text,
           description, file_url, created_by, created_at, updated_at
    FROM letter_database
    WHERE id = $1
    LIMIT 1
    `,
    [id]
  );

  if (result.rowCount === 0) return null;
  return mapLetterDatabaseRow(result.rows[0]);
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    await ensureLetterDatabaseTable();
    const result = await query(`
      SELECT id, title, category, number, TO_CHAR(date, 'YYYY-MM-DD') AS date_text,
             description, file_url, created_by, created_at, updated_at
      FROM letter_database
      ORDER BY COALESCE(date, created_at::date) DESC, created_at DESC
    `);

    res.json(result.rows.map(mapLetterDatabaseRow));
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    await ensureLetterDatabaseTable();
    if (!requireOperator(req, res)) return;

    const { title, category, number, date, description, fileDataUrl, fileName } = req.body || {};
    if (!String(title || "").trim() || !String(category || "").trim()) {
      return res.status(400).json({ message: "title dan category wajib diisi." });
    }

    let fileUrl = null;
    if (typeof fileDataUrl === "string" && fileDataUrl.trim()) {
      try {
        fileUrl = await saveLetterDatabaseFile(fileDataUrl.trim(), fileName);
      } catch (error) {
        return res.status(error?.statusCode || 400).json({ message: error?.message || "Gagal upload file surat." });
      }
    }

    const id = `LDB-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    await query(
      `
      INSERT INTO letter_database (
        id, title, category, number, date, description, file_url, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        id,
        String(title).trim(),
        String(category).trim(),
        number || null,
        date || null,
        description || null,
        fileUrl,
        resolveUserId(req)
      ]
    );

    res.status(201).json(await fetchLetterDatabaseItem(id));
  })
);

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    await ensureLetterDatabaseTable();
    if (!requireOperator(req, res)) return;

    const existing = await fetchLetterDatabaseItem(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: "Data surat tidak ditemukan." });
    }

    const body = req.body || {};
    const { title, category, number, date, description, fileDataUrl, fileName } = body;
    let fileUrl = null;
    if (typeof fileDataUrl === "string" && fileDataUrl.trim()) {
      try {
        fileUrl = await saveLetterDatabaseFile(fileDataUrl.trim(), fileName);
      } catch (error) {
        return res.status(error?.statusCode || 400).json({ message: error?.message || "Gagal upload file surat." });
      }
    }

    if (hasOwn(body, "title") && !String(title || "").trim()) {
      return res.status(400).json({ message: "title tidak boleh kosong." });
    }
    if (hasOwn(body, "category") && !String(category || "").trim()) {
      return res.status(400).json({ message: "category tidak boleh kosong." });
    }

    await query(
      `
      UPDATE letter_database
      SET title = CASE WHEN $2::boolean THEN $3 ELSE title END,
          category = CASE WHEN $4::boolean THEN $5 ELSE category END,
          number = CASE WHEN $6::boolean THEN $7 ELSE number END,
          date = CASE WHEN $8::boolean THEN $9::date ELSE date END,
          description = CASE WHEN $10::boolean THEN $11 ELSE description END,
          file_url = COALESCE($12, file_url),
          updated_at = NOW()
      WHERE id = $1
      `,
      [
        req.params.id,
        hasOwn(body, "title"),
        title == null ? null : String(title).trim(),
        hasOwn(body, "category"),
        category == null ? null : String(category).trim(),
        hasOwn(body, "number"),
        number || null,
        hasOwn(body, "date"),
        date || null,
        hasOwn(body, "description"),
        description || null,
        fileUrl
      ]
    );

    res.json(await fetchLetterDatabaseItem(req.params.id));
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await ensureLetterDatabaseTable();
    if (!requireOperator(req, res)) return;

    const result = await query("DELETE FROM letter_database WHERE id = $1 RETURNING id", [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Data surat tidak ditemukan." });
    }

    res.json({ message: "Data surat berhasil dihapus." });
  })
);

module.exports = router;
