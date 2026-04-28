const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { buildWhereClause } = require("../../utils/queryFilters");
const { extractRole } = require("../../utils/roleGuard");
const { resolveStudentId, resolveStudentRecord } = require("../../utils/studentResolver");
const { createNotification } = require("../../utils/notificationService");
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
  return String(req.authUser?.id || req.headers["x-user-id"] || req.query.userId || req.body?.userId || "").trim();
}

async function ensureLetterRequestColumns() {
  if (!ensureColumnsPromise) {
    ensureColumnsPromise = (async () => {
      await query(`
        ALTER TABLE letter_requests
        ALTER COLUMN student_id DROP NOT NULL
      `);
      await query(`
        ALTER TABLE letter_requests
        ADD COLUMN IF NOT EXISTS requester_type TEXT NOT NULL DEFAULT 'student',
        ADD COLUMN IF NOT EXISTS requester_id TEXT,
        ADD COLUMN IF NOT EXISTS project_id TEXT,
        ADD COLUMN IF NOT EXISTS catatan TEXT,
        ADD COLUMN IF NOT EXISTS file_url TEXT
      `);
      await query(`
        UPDATE letter_requests lr
        SET requester_type = 'student',
            requester_id = s.user_id
        FROM students s
        WHERE lr.student_id = s.id
          AND (lr.requester_type IS NULL OR lr.requester_id IS NULL)
      `);
    })();
  }
  await ensureColumnsPromise;
}

async function resolveLecturerRequester(lecturerIdOrUserId) {
  const lookupValue = String(lecturerIdOrUserId || "").trim();
  if (!lookupValue) return null;

  const result = await query(
    `
    SELECT l.id AS lecturer_id, l.user_id, u.name
    FROM lecturers l
    JOIN users u ON u.id = l.user_id
    WHERE l.id = $1 OR l.user_id = $1
    LIMIT 1
    `,
    [lookupValue]
  );

  if (result.rowCount === 0) return null;
  return result.rows[0];
}

async function resolveAnyRequesterUserId(requesterType, requesterId) {
  const normalizedType = String(requesterType || "").trim().toLowerCase();
  const lookupValue = String(requesterId || "").trim();
  if (!lookupValue) return null;

  if (normalizedType === "student") {
    const student = await resolveStudentRecord(lookupValue);
    return student?.user_id || null;
  }

  if (normalizedType === "lecturer") {
    const lecturer = await resolveLecturerRequester(lookupValue);
    return lecturer?.user_id || null;
  }

  const directUser = await query("SELECT id FROM users WHERE id = $1 LIMIT 1", [lookupValue]);
  if (directUser.rowCount > 0) return directUser.rows[0].id;

  const student = await resolveStudentRecord(lookupValue);
  if (student?.user_id) return student.user_id;

  const lecturer = await resolveLecturerRequester(lookupValue);
  return lecturer?.user_id || null;
}

async function ensureResearchProjectExists(projectId) {
  if (!projectId) return;

  const result = await query("SELECT id FROM research_projects WHERE id = $1 LIMIT 1", [projectId]);
  if (result.rowCount === 0) {
    const error = new Error("Riset yang dipilih tidak ditemukan.");
    error.statusCode = 404;
    throw error;
  }
}

function buildLetterRequestId(requesterType) {
  const prefix = requesterType === "lecturer" ? "LTR-DSN" : "LTR-STD";
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

function mapLetterRequestRow(row) {
  return {
    id: row.id,
    requesterType: row.requester_type,
    requesterId: row.requester_id,
    requesterName: row.requester_name,
    requester_type: row.requester_type,
    requester_id: row.requester_id,
    requester_name: row.requester_name,
    studentId: row.student_id,
    student_id: row.student_id,
    student_name: row.student_name,
    student_initials: row.student_initials,
    nim: row.nim,
    lecturerId: row.lecturer_id,
    lecturer_id: row.lecturer_id,
    jenis: row.jenis,
    tanggal: row.tanggal,
    tujuan: row.tujuan,
    catatan: row.catatan,
    status: row.status,
    estimasi: row.estimasi,
    nomor_surat: row.nomor_surat,
    file_url: row.file_url,
    projectId: row.project_id,
    project_id: row.project_id,
    projectName: row.project_name,
    project_name: row.project_name
  };
}

async function fetchLetterRequestById(id) {
  const result = await query(
    `
    SELECT lr.id, lr.student_id, lr.requester_type, lr.requester_id,
           su.name AS student_name, su.initials AS student_initials, s.nim,
           l.id AS lecturer_id,
           CASE
             WHEN lr.requester_type = 'lecturer' THEN lu.name
             ELSE COALESCE(ru.name, su.name)
           END AS requester_name,
           lr.jenis, lr.tanggal, lr.tujuan, lr.catatan,
           lr.status, lr.estimasi, lr.nomor_surat, lr.file_url,
           lr.project_id, COALESCE(rp.short_title, rp.title) AS project_name
    FROM letter_requests lr
    LEFT JOIN students s ON s.id = lr.student_id
    LEFT JOIN users su ON su.id = s.user_id
    LEFT JOIN users ru ON ru.id = lr.requester_id
    LEFT JOIN lecturers l ON l.user_id = lr.requester_id
    LEFT JOIN users lu ON lu.id = l.user_id
    LEFT JOIN research_projects rp ON rp.id = lr.project_id
    WHERE lr.id = $1
    LIMIT 1
    `,
    [id]
  );

  if (result.rowCount === 0) return null;
  return mapLetterRequestRow(result.rows[0]);
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
    const requesterUserId = resolveRequesterUserId(req);
    const {
      status,
      studentId,
      lecturerId,
      requesterType,
      requesterId,
      projectId
    } = req.query;

    let resolvedStudentId = null;
    let resolvedLecturer = null;
    let resolvedRequesterUserId = null;

    if (role === "mahasiswa") {
      const student = await resolveStudentRecord(studentId || requesterUserId);
      if (!(student?.id)) {
        return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
      }
      resolvedStudentId = student.id;
    } else if (role === "dosen") {
      resolvedLecturer = await resolveLecturerRequester(lecturerId || requesterId || requesterUserId);
      if (!resolvedLecturer) {
        return res.status(404).json({ message: "Dosen tidak ditemukan." });
      }
      resolvedRequesterUserId = resolvedLecturer.user_id;
    } else {
      if (studentId) {
        resolvedStudentId = await resolveStudentId(String(studentId));
        if (!resolvedStudentId) {
          return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
        }
      }

      if (lecturerId) {
        resolvedLecturer = await resolveLecturerRequester(lecturerId);
        if (!resolvedLecturer) {
          return res.status(404).json({ message: "Dosen tidak ditemukan." });
        }
      }

      if (requesterId) {
        resolvedRequesterUserId = await resolveAnyRequesterUserId(requesterType, requesterId);
        if (!resolvedRequesterUserId) {
          return res.status(404).json({ message: "Requester tidak ditemukan." });
        }
      }
    }

    const { whereClause, params } = buildWhereClause([
      { value: status, sql: (index) => `lr.status = $${index}` },
      { value: requesterType, sql: (index) => `lr.requester_type = $${index}` },
      { value: resolvedStudentId, sql: (index) => `lr.student_id = $${index}` },
      { value: resolvedLecturer?.user_id, sql: (index) => `lr.requester_id = $${index}` },
      { value: resolvedRequesterUserId, sql: (index) => `lr.requester_id = $${index}` },
      { value: projectId, sql: (index) => `lr.project_id = $${index}` }
    ]);

    const result = await query(
      `
      SELECT lr.id, lr.student_id, lr.requester_type, lr.requester_id,
             su.name AS student_name, su.initials AS student_initials,
             s.nim, l.id AS lecturer_id,
             CASE
               WHEN lr.requester_type = 'lecturer' THEN lu.name
               ELSE COALESCE(ru.name, su.name)
             END AS requester_name,
             lr.jenis, lr.tanggal, lr.tujuan, lr.catatan,
             lr.status, lr.estimasi, lr.nomor_surat, lr.file_url,
             lr.project_id, COALESCE(rp.short_title, rp.title) AS project_name
      FROM letter_requests lr
      LEFT JOIN students s ON s.id = lr.student_id
      LEFT JOIN users su ON su.id = s.user_id
      LEFT JOIN users ru ON ru.id = lr.requester_id
      LEFT JOIN lecturers l ON l.user_id = lr.requester_id
      LEFT JOIN users lu ON lu.id = l.user_id
      LEFT JOIN research_projects rp ON rp.id = lr.project_id
      ${whereClause}
      ORDER BY lr.tanggal DESC, lr.id DESC
      `,
      params
    );

    res.json(result.rows.map(mapLetterRequestRow));
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    await ensureLetterRequestColumns();
    const role = extractRole(req);
    if (role && !["mahasiswa", "dosen"].includes(role)) {
      return res.status(403).json({ message: "Hanya mahasiswa/dosen yang dapat membuat pengajuan surat." });
    }

    const {
      id,
      studentId,
      lecturerId,
      requesterType,
      requesterId,
      jenis,
      tanggal,
      tujuan,
      projectId,
      catatan
    } = req.body;

    if (!jenis || !tanggal || !tujuan) {
      return res.status(400).json({ message: "jenis, tanggal, tujuan wajib diisi." });
    }

    const requesterUserId = resolveRequesterUserId(req);
    const normalizedRequesterType = String(
      requesterType || (lecturerId ? "lecturer" : (studentId ? "student" : (role === "dosen" ? "lecturer" : "student")))
    ).trim().toLowerCase();

    if (!["student", "lecturer"].includes(normalizedRequesterType)) {
      return res.status(400).json({ message: "requesterType harus student atau lecturer." });
    }

    if (role === "mahasiswa" && normalizedRequesterType !== "student") {
      return res.status(403).json({ message: "Mahasiswa hanya dapat membuat pengajuan surat sebagai mahasiswa." });
    }
    if (role === "dosen" && normalizedRequesterType !== "lecturer") {
      return res.status(403).json({ message: "Dosen hanya dapat membuat pengajuan surat sebagai dosen." });
    }

    await ensureResearchProjectExists(projectId || null);

    let resolvedStudent = null;
    let resolvedRequesterId = null;
    if (normalizedRequesterType === "student") {
      if (!studentId) {
        return res.status(400).json({ message: "studentId wajib diisi untuk pengajuan mahasiswa." });
      }

      resolvedStudent = await resolveStudentRecord(String(studentId));
      if (!resolvedStudent) {
        return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
      }
      if (requesterUserId && String(resolvedStudent.user_id) !== String(requesterUserId)) {
        return res.status(403).json({ message: "studentId tidak sesuai dengan akun login." });
      }
      resolvedRequesterId = resolvedStudent.user_id;
    } else {
      const lecturer = await resolveLecturerRequester(lecturerId || requesterId || requesterUserId);
      if (!lecturer) {
        return res.status(404).json({ message: "Dosen tidak ditemukan." });
      }
      if (requesterUserId && String(lecturer.user_id) !== String(requesterUserId)) {
        return res.status(403).json({ message: "requesterId tidak sesuai dengan akun login." });
      }
      resolvedRequesterId = lecturer.user_id;
    }

    const letterRequestId = id || buildLetterRequestId(normalizedRequesterType);

    await query(
      `
      INSERT INTO letter_requests (
        id, student_id, requester_type, requester_id, jenis, tanggal, tujuan, project_id, catatan, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Menunggu')
      `,
      [
        letterRequestId,
        resolvedStudent?.id || null,
        normalizedRequesterType,
        resolvedRequesterId,
        jenis,
        tanggal,
        tujuan,
        projectId || null,
        catatan || null
      ]
    );

    const createdRequest = await fetchLetterRequestById(letterRequestId);

    const operatorsResult = await query("SELECT id FROM users WHERE role = 'operator' AND is_active = TRUE");
    await Promise.all(
      operatorsResult.rows.map((row) =>
        createNotification({
          recipientUserId: row.id,
          title: "Pengajuan Surat Baru",
          body: `${createdRequest?.requesterName || "Pengguna"} mengajukan permintaan surat ${jenis}.`,
          senderUserId: resolvedRequesterId,
          type: "surat",
          eventId: "surat_request"
        })
      )
    );

    res.status(201).json({
      message: "Pengajuan surat berhasil dibuat.",
      data: createdRequest
    });
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

    const updatedRequest = await fetchLetterRequestById(req.params.id);
    const requesterRecipientId = updatedRequest?.requesterId;
    if (requesterRecipientId) {
      await createNotification({
        recipientUserId: requesterRecipientId,
        title: "Status Surat Diperbarui",
        body: `Permintaan surat Anda (${updatedRequest?.jenis || req.params.id}) sekarang berstatus ${status}.`,
        senderUserId: resolveRequesterUserId(req) || null,
        type: "surat",
        eventId: "surat_request"
      });
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
