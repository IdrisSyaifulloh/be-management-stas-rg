const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { extractRole } = require("../../utils/roleGuard");
const { resolveStudentId } = require("../../utils/studentResolver");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();
const CERT_UPLOAD_DIR = path.join(__dirname, "../../public/uploads/certificates");
const ALLOWED_CERT_FILE_TYPES = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg"
};

function resolveRequesterUserId(req) {
  return String(req.headers["x-user-id"] || req.query.userId || req.body?.userId || "").trim();
}

async function canDosenAccessProject(userId, projectId) {
  if (!userId || !projectId) return false;
  const result = await query(
    `
    SELECT 1
    FROM research_projects rp
    LEFT JOIN lecturers l ON l.id = rp.supervisor_lecturer_id
    LEFT JOIN research_memberships rm
      ON rm.project_id = rp.id
     AND rm.user_id = $1
     AND rm.member_type = 'Dosen'
    WHERE rp.id = $2
      AND (l.user_id = $1 OR rm.user_id IS NOT NULL)
    LIMIT 1
    `,
    [userId, projectId]
  );
  return result.rowCount > 0;
}

function sanitizeFilenameBase(name) {
  return String(name || "sertifikat")
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "sertifikat";
}

async function saveCertificateFile(fileDataUrl, originalFileName) {
  const match = String(fileDataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    const error = new Error("Format file tidak valid. Gunakan data URL base64.");
    error.statusCode = 400;
    throw error;
  }

  const mimeType = match[1];
  const base64Payload = match[2];
  const extension = ALLOWED_CERT_FILE_TYPES[mimeType];
  if (!extension) {
    const error = new Error("Tipe file harus PDF, PNG, atau JPG.");
    error.statusCode = 400;
    throw error;
  }

  let buffer;
  try {
    buffer = Buffer.from(base64Payload, "base64");
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

  await fs.mkdir(CERT_UPLOAD_DIR, { recursive: true });
  const cleanBaseName = sanitizeFilenameBase(originalFileName);
  const finalName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${cleanBaseName}${extension}`;
  await fs.writeFile(path.join(CERT_UPLOAD_DIR, finalName), buffer);
  return `/uploads/certificates/${finalName}`;
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    const requesterUserId = resolveRequesterUserId(req);
    const { status, studentId, projectId } = req.query;

    const params = [];
    const where = [`rm_mahasiswa.member_type = 'Mahasiswa'`];
    const push = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (status) {
      where.push(`COALESCE(cr.status, 'Belum Diminta') = ${push(status)}`);
    }

    const resolvedStudentId = studentId ? await resolveStudentId(String(studentId)) : null;
    if (studentId && !resolvedStudentId) {
      return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    }
    if (resolvedStudentId) {
      where.push(`s.id = ${push(resolvedStudentId)}`);
    }

    if (projectId) {
      where.push(`rp.id = ${push(String(projectId))}`);
    }

    if (role === "mahasiswa") {
      const myStudentId = await resolveStudentId(requesterUserId);
      if (!myStudentId) {
        return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
      }
      where.push(`s.id = ${push(myStudentId)}`);
    } else if (role === "dosen") {
      if (!requesterUserId) {
        return res.status(400).json({ message: "userId wajib diisi." });
      }
      where.push(
        `
        (
          l.user_id = ${push(requesterUserId)}
          OR (
            rm_dosen.user_id = ${push(requesterUserId)}
            AND rm_dosen.member_type = 'Dosen'
          )
        )
        `
      );
    } else if (role !== "operator") {
      return res.status(403).json({ message: "Role tidak diizinkan mengakses data sertifikat." });
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const result = await query(
      `
      SELECT
        COALESCE(cr.id, 'CR-VIRTUAL-' || rp.id || '-' || s.id) AS id,
        cr.id AS real_id,
        s.id AS student_id,
        su.name AS student_name,
        su.initials AS student_initials,
        s.nim,
        rp.id AS project_id,
        COALESCE(rp.short_title, rp.title) AS project_name,
        rm_mahasiswa.peran AS student_role,
        cr.requested_by,
        ru.name AS requested_by_name,
        COALESCE(cr.status, 'Belum Diminta') AS status,
        cr.kontribusi_selesai_date,
        cr.request_note,
        cr.issue_date,
        cr.certificate_number,
        cr.file_url,
        cr.created_at,
        cr.updated_at,
        (cr.id IS NULL) AS is_virtual
      FROM research_memberships rm_mahasiswa
      JOIN research_projects rp ON rp.id = rm_mahasiswa.project_id
      JOIN students s ON s.user_id = rm_mahasiswa.user_id
      JOIN users su ON su.id = s.user_id
      LEFT JOIN certificate_requests cr ON cr.student_id = s.id AND cr.project_id = rp.id
      LEFT JOIN users ru ON ru.id = cr.requested_by
      LEFT JOIN lecturers l ON l.id = rp.supervisor_lecturer_id
      LEFT JOIN research_memberships rm_dosen ON rm_dosen.project_id = rp.id
      ${whereClause}
      ORDER BY rp.id ASC, su.name ASC
      `,
      params
    );

    res.json(result.rows);
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    const requesterUserId = resolveRequesterUserId(req);
    const {
      id,
      studentId,
      projectId,
      requestedBy,
      kontribusiSelesaiDate,
      requestNote
    } = req.body;

    if (!id || !studentId || !projectId) {
      return res.status(400).json({ message: "id, studentId, projectId wajib diisi." });
    }

    const resolvedStudentId = await resolveStudentId(String(studentId));
    if (!resolvedStudentId) {
      return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    }

    if (role === "mahasiswa") {
      const myStudentId = await resolveStudentId(requesterUserId);
      if (!myStudentId || String(myStudentId) !== String(resolvedStudentId)) {
        return res.status(403).json({ message: "Mahasiswa hanya bisa mengajukan sertifikat untuk dirinya sendiri." });
      }
    } else if (role === "dosen") {
      const allowed = await canDosenAccessProject(requesterUserId, projectId);
      if (!allowed) {
        return res.status(403).json({ message: "Dosen tidak memiliki akses ke riset ini." });
      }
    } else if (role !== "operator") {
      return res.status(403).json({ message: "Role tidak diizinkan mengajukan sertifikat." });
    }

    const effectiveRequestedBy = requestedBy || requesterUserId || null;

    await query(
      `
      INSERT INTO certificate_requests (
        id, student_id, project_id, requested_by,
        status, kontribusi_selesai_date, request_note
      ) VALUES ($1, $2, $3, $4, 'Diproses', $5, $6)
      ON CONFLICT (student_id, project_id)
      DO UPDATE SET status = 'Diproses',
                    requested_by = EXCLUDED.requested_by,
                    kontribusi_selesai_date = EXCLUDED.kontribusi_selesai_date,
                    request_note = EXCLUDED.request_note,
                    updated_at = NOW()
      `,
      [id, resolvedStudentId, projectId, effectiveRequestedBy, kontribusiSelesaiDate || null, requestNote || null]
    );

    res.status(201).json({ message: "Permintaan sertifikat berhasil dikirim." });
  })
);

router.patch(
  "/:id/status",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat mengubah status sertifikat." });
    }

    const { status, issueDate, certificateNumber, fileUrl, fileDataUrl, fileName } = req.body;

    if (!status || !["Belum Diminta", "Diproses", "Terbit"].includes(status)) {
      return res.status(400).json({ message: "status harus Belum Diminta/Diproses/Terbit." });
    }

    let uploadedFileUrl = null;
    if (typeof fileDataUrl === "string" && fileDataUrl.trim()) {
      try {
        uploadedFileUrl = await saveCertificateFile(fileDataUrl.trim(), fileName);
      } catch (error) {
        const statusCode = error?.statusCode || 400;
        return res.status(statusCode).json({ message: error?.message || "Gagal memproses upload file sertifikat." });
      }
    }

    const manualFileUrl = typeof fileUrl === "string" && fileUrl.trim() ? fileUrl.trim() : null;
    const effectiveFileUrl = uploadedFileUrl || manualFileUrl;

    const result = await query(
      `
      UPDATE certificate_requests
      SET status = $2,
          issue_date = COALESCE($3, issue_date),
          certificate_number = COALESCE($4, certificate_number),
          file_url = COALESCE($5, file_url),
          updated_at = NOW()
      WHERE id = $1
      RETURNING id
      `,
      [req.params.id, status, issueDate || null, certificateNumber || null, effectiveFileUrl]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Data sertifikat tidak ditemukan." });
    }

    res.json({ message: "Status sertifikat berhasil diperbarui." });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat menghapus data sertifikat." });
    }

    const result = await query("DELETE FROM certificate_requests WHERE id = $1 RETURNING id", [req.params.id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Data sertifikat tidak ditemukan." });
    }

    res.json({ message: "Data sertifikat berhasil dihapus." });
  })
);

module.exports = router;
