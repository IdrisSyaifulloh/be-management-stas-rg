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

const ROMAN_MONTHS = ['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'];

const SEED_CATEGORIES = [
  { id: 'lcat-01', name: 'Surat Keputusan',                 kode: '01', singkatan: 'SK'    },
  { id: 'lcat-02', name: 'Surat Undangan',                  kode: '02', singkatan: 'SU'    },
  { id: 'lcat-03', name: 'Surat Permohonan',                kode: '03', singkatan: 'SPM'   },
  { id: 'lcat-04', name: 'Surat Pemberitahuan',             kode: '04', singkatan: 'SPb'   },
  { id: 'lcat-05', name: 'Surat Peminjaman',                kode: '05', singkatan: 'SPP'   },
  { id: 'lcat-06', name: 'Surat Pernyataan',                kode: '06', singkatan: 'SPn'   },
  { id: 'lcat-07', name: 'Surat Mandat',                    kode: '07', singkatan: 'SM'    },
  { id: 'lcat-08', name: 'Surat Tugas',                     kode: '08', singkatan: 'ST'    },
  { id: 'lcat-09', name: 'Surat Keterangan',                kode: '09', singkatan: 'Sket'  },
  { id: 'lcat-10', name: 'Surat Rekomendasi',               kode: '10', singkatan: 'SR'    },
  { id: 'lcat-11', name: 'Surat Balasan',                   kode: '11', singkatan: 'SB'    },
  { id: 'lcat-12', name: 'Surat Perintah Perjalanan Dinas', kode: '12', singkatan: 'SPPD'  },
  { id: 'lcat-13', name: 'Sertifikat',                      kode: '13', singkatan: 'SRT'   },
  { id: 'lcat-14', name: 'Perjanjian Kerja',                kode: '14', singkatan: 'PK'    },
  { id: 'lcat-15', name: 'Surat Pengantar',                 kode: '15', singkatan: 'SPeng' },
  { id: 'lcat-16', name: 'Nota',                            kode: '16', singkatan: null    },
  { id: 'lcat-17', name: 'Surat Berita Acara Serah Terima', kode: '17', singkatan: null    },
];

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
      await query(`ALTER TABLE letter_categories ADD COLUMN IF NOT EXISTS kode      TEXT`);
      await query(`ALTER TABLE letter_categories ADD COLUMN IF NOT EXISTS singkatan TEXT`);

      for (const cat of SEED_CATEGORIES) {
        await query(
          `INSERT INTO letter_categories (id, name, kode, singkatan)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO NOTHING`,
          [cat.id, cat.name, cat.kode, cat.singkatan]
        );
      }
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
      SELECT id, name, kode, singkatan, created_at, updated_at
      FROM letter_categories
      ORDER BY kode ASC NULLS LAST, name ASC
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

router.get(
  "/:id/next-nomor",
  asyncHandler(async (req, res) => {
    await ensureLetterCategoriesTable();
    if (!requireOperator(req, res)) return;

    const catResult = await query(
      "SELECT id, name, kode FROM letter_categories WHERE id = $1 LIMIT 1",
      [req.params.id]
    );
    if (catResult.rowCount === 0) {
      return res.status(404).json({ message: "Kategori surat tidak ditemukan." });
    }

    const { name, kode } = catResult.rows[0];
    if (!kode) {
      return res.json({ nomor: null, message: "Kategori ini tidak memiliki kode nomor." });
    }

    const now = new Date();
    const tahun = now.getFullYear();
    const bulan = ROMAN_MONTHS[now.getMonth()];

    const seqResult = await query(
      `SELECT COUNT(*)::int AS cnt
       FROM letter_database
       WHERE LOWER(category) = LOWER($1)
         AND EXTRACT(YEAR FROM COALESCE(date::date, created_at)) = $2`,
      [name, tahun]
    );
    const seq = String(seqResult.rows[0].cnt + 1).padStart(3, "0");
    const nomor = `${kode}.${seq}/STASRG/${bulan}/${tahun}`;

    return res.json({ nomor });
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
