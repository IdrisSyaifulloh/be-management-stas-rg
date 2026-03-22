const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { buildWhereClause } = require("../../utils/queryFilters");
const { extractRole } = require("../../utils/roleGuard");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();
const LETTER_UPLOAD_DIR = path.join(__dirname, "../../public/uploads/letters");
const ALLOWED_LETTER_FILE_TYPES = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "image/png": ".png",
  "image/jpeg": ".jpg"
};
let ensureColumnsPromise = null;

function resolveRequesterUserId(req) {
  return String(req.headers["x-user-id"] || req.query.userId || req.body?.userId || "").trim();
}

async function resolveStudentId(studentIdOrUserId) {
  const result = await query("SELECT id FROM students WHERE id = $1 OR user_id = $1 LIMIT 1", [studentIdOrUserId]);
  if (result.rowCount === 0) return null;
  return result.rows[0].id;
}

async function ensureLetterRequestColumns() {
  if (!ensureColumnsPromise) {
    ensureColumnsPromise = query("ALTER TABLE letter_requests ADD COLUMN IF NOT EXISTS file_url TEXT");
  }
  await ensureColumnsPromise;
}

function sanitizeFilenameBase(name) {
  return String(name || "surat")
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "surat";
}

async function saveLetterFile(fileDataUrl, originalFileName) {
  const match = String(fileDataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    const error = new Error("Format file tidak valid.");
    error.statusCode = 400;
    throw error;
  }

  const mimeType = match[1];
  const payload = match[2];
  const extension = ALLOWED_LETTER_FILE_TYPES[mimeType];
  if (!extension) {
    const error = new Error("Tipe file harus PDF, DOC, DOCX, PNG, atau JPG.");
    error.statusCode = 400;
    throw error;
  }

  let buffer;
  try {
    buffer = Buffer.from(payload, "base64");
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

  await fs.mkdir(LETTER_UPLOAD_DIR, { recursive: true });
  const baseName = sanitizeFilenameBase(originalFileName);
  const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${baseName}${extension}`;
  await fs.writeFile(path.join(LETTER_UPLOAD_DIR, fileName), buffer);
  return `/uploads/letters/${fileName}`;
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    await ensureLetterRequestColumns();
    const role = extractRole(req);
    const requestedStudentId = req.query.studentId;
    const requesterUserId = resolveRequesterUserId(req);
    const studentIdInput = role === "mahasiswa" ? (requestedStudentId || requesterUserId) : requestedStudentId;
    const resolvedStudentId = studentIdInput ? await resolveStudentId(String(studentIdInput)) : null;
    if (studentIdInput && !resolvedStudentId) {
      return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    }

    const { status } = req.query;
    const { whereClause, params } = buildWhereClause([
      { value: status, sql: (index) => `lr.status = $${index}` },
      { value: resolvedStudentId, sql: (index) => `lr.student_id = $${index}` }
    ]);

    const result = await query(
      `
      SELECT lr.id, lr.student_id, su.name AS student_name, su.initials AS student_initials,
             s.nim, lr.jenis, lr.tanggal, lr.tujuan,
             lr.status, lr.estimasi, lr.nomor_surat, lr.file_url
      FROM letter_requests lr
      JOIN students s ON s.id = lr.student_id
      JOIN users su ON su.id = s.user_id
      ${whereClause}
      ORDER BY lr.tanggal DESC, lr.id DESC
      `,
      params
    );

    res.json(result.rows);
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    await ensureLetterRequestColumns();
    const role = extractRole(req);
    if (role !== "mahasiswa") {
      return res.status(403).json({ message: "Hanya mahasiswa yang dapat membuat pengajuan surat." });
    }

    const { id, studentId, jenis, tanggal, tujuan } = req.body;

    if (!id || !studentId || !jenis || !tanggal || !tujuan) {
      return res.status(400).json({ message: "id, studentId, jenis, tanggal, tujuan wajib diisi." });
    }

    const requesterUserId = resolveRequesterUserId(req);
    if (requesterUserId && String(studentId) !== String(requesterUserId)) {
      return res.status(403).json({ message: "studentId tidak sesuai dengan akun login." });
    }

    const resolvedStudentId = await resolveStudentId(String(studentId));
    if (!resolvedStudentId) {
      return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    }

    await query(
      `
      INSERT INTO letter_requests (id, student_id, jenis, tanggal, tujuan, status)
      VALUES ($1, $2, $3, $4, $5, 'Menunggu')
      `,
      [id, resolvedStudentId, jenis, tanggal, tujuan]
    );

    res.status(201).json({ message: "Pengajuan surat berhasil dibuat." });
  })
);

router.patch(
  "/:id/status",
  asyncHandler(async (req, res) => {
    await ensureLetterRequestColumns();
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat mengubah status surat." });
    }

    const { status, estimasi, nomorSurat, fileUrl, fileDataUrl, fileName } = req.body;

    if (!status || !["Menunggu", "Diproses", "Siap Unduh"].includes(status)) {
      return res.status(400).json({ message: "status harus Menunggu/Diproses/Siap Unduh." });
    }

    let uploadedFileUrl = null;
    if (typeof fileDataUrl === "string" && fileDataUrl.trim()) {
      try {
        uploadedFileUrl = await saveLetterFile(fileDataUrl.trim(), fileName);
      } catch (error) {
        const statusCode = error?.statusCode || 400;
        return res.status(statusCode).json({ message: error?.message || "Gagal upload dokumen surat." });
      }
    }

    const manualFileUrl = typeof fileUrl === "string" && fileUrl.trim() ? fileUrl.trim() : null;
    const effectiveFileUrl = uploadedFileUrl || manualFileUrl;

    const result = await query(
      `
      UPDATE letter_requests
      SET status = $2,
          estimasi = COALESCE($3, estimasi),
          nomor_surat = COALESCE($4, nomor_surat),
          file_url = COALESCE($5, file_url),
          updated_at = NOW()
      WHERE id = $1
      RETURNING id
      `,
      [req.params.id, status, estimasi || null, nomorSurat || null, effectiveFileUrl]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Pengajuan surat tidak ditemukan." });
    }

    res.json({ message: "Status surat berhasil diperbarui." });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await ensureLetterRequestColumns();
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat menghapus pengajuan surat." });
    }

    const result = await query("DELETE FROM letter_requests WHERE id = $1 RETURNING id", [req.params.id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Pengajuan surat tidak ditemukan." });
    }

    res.json({ message: "Pengajuan surat berhasil dihapus." });
  })
);

module.exports = router;
