const express = require("express");
const crypto = require("crypto");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { extractRole } = require("../../utils/roleGuard");
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
let ensureTablePromise = null;

function requireOperator(req, res) {
  const role = extractRole(req);
  if (role !== "operator") {
    res.status(403).json({ message: "Hanya operator yang dapat mengelola kategori surat." });
    return false;
  }
  return true;
}

async function ensureLetterCategoriesTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS letter_categories (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_letter_categories_name_lower
        ON letter_categories (LOWER(name))
      `);
    })();
  }
  await ensureTablePromise;
}

function normalizeName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  return name || null;
}

router.get(
  "/",
  asyncHandler(async (_req, res) => {
    await ensureLetterCategoriesTable();
    const result = await query(`
      SELECT id, name, created_at, updated_at
      FROM letter_categories
      ORDER BY name ASC
    `);

    return res.json(result.rows);
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    await ensureLetterCategoriesTable();
    if (!requireOperator(req, res)) return;

    const name = normalizeName(req.body?.name);
    if (!name) {
      return res.status(400).json({ message: "name wajib diisi." });
    }

    const id = `LCAT-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    try {
      const result = await query(
        `
        INSERT INTO letter_categories (id, name)
        VALUES ($1, $2)
        RETURNING id, name, created_at, updated_at
        `,
        [id, name]
      );

      return res.status(201).json(result.rows[0]);
    } catch (error) {
      if (error?.code === "23505") {
        return res.status(409).json({ message: "Kategori surat sudah ada." });
      }
      throw error;
    }
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await ensureLetterCategoriesTable();
    if (!requireOperator(req, res)) return;

    const categoryResult = await query(
      "SELECT id, name FROM letter_categories WHERE id = $1 LIMIT 1",
      [req.params.id]
    );

    if (categoryResult.rowCount === 0) {
      return res.status(404).json({ message: "Kategori surat tidak ditemukan." });
    }

    const tableResult = await query("SELECT to_regclass('public.letter_database') AS table_name");
    const usedResult = tableResult.rows[0]?.table_name
      ? await query(
        "SELECT 1 FROM letter_database WHERE LOWER(category) = LOWER($1) LIMIT 1",
        [categoryResult.rows[0].name]
      )
      : { rowCount: 0 };

    if (usedResult.rowCount > 0) {
      return res.status(409).json({ message: "Kategori masih digunakan oleh data surat." });
    }

    await query("DELETE FROM letter_categories WHERE id = $1", [req.params.id]);
    return res.json({ message: "Kategori surat berhasil dihapus." });
  })
);

module.exports = router;
