const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { buildWhereClause } = require("../../utils/queryFilters");
const { extractRole } = require("../../utils/roleGuard");
const { resolveStudentId } = require("../../utils/studentResolver");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { requireSafeId } = require("../../utils/securityValidation");

const router = express.Router();
const LOGBOOK_UPLOAD_DIR = path.join(__dirname, "../../public/uploads/logbooks");
const MAX_LOGBOOK_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const ALLOWED_LOGBOOK_FILE_TYPES = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "application/zip": ".zip",
  "application/x-zip-compressed": ".zip"
};
let ensureLogbookColumnsPromise = null;

async function ensureLogbookAttachmentColumns() {
  if (!ensureLogbookColumnsPromise) {
    ensureLogbookColumnsPromise = query(`
      ALTER TABLE logbook_entries
      ALTER COLUMN project_id DROP NOT NULL,
      ADD COLUMN IF NOT EXISTS file_url TEXT,
      ADD COLUMN IF NOT EXISTS file_name TEXT,
      ADD COLUMN IF NOT EXISTS file_size BIGINT
    `);
  }
  await ensureLogbookColumnsPromise;
}

function normalizeOptionalProjectId(projectId) {
  const normalized = String(projectId || "").trim();
  if (["null", "undefined"].includes(normalized.toLowerCase())) return null;
  return normalized || null;
}

async function ensureProjectCanBeUsed(projectId, studentId) {
  const normalizedProjectId = normalizeOptionalProjectId(projectId);
  if (!normalizedProjectId) return null;

  const result = await query(
    `
    SELECT rp.id
    FROM research_projects rp
    JOIN research_memberships rm ON rm.project_id = rp.id
    JOIN students s ON s.user_id = rm.user_id
    WHERE rp.id = $1
      AND s.id = $2
      AND rm.status = 'Aktif'
    LIMIT 1
    `,
    [normalizedProjectId, studentId]
  );

  if (result.rowCount === 0) {
    const error = new Error("Riset yang dipilih tidak ditemukan atau tidak terhubung dengan mahasiswa.");
    error.statusCode = 404;
    throw error;
  }

  return normalizedProjectId;
}

function sanitizeFilenameBase(name) {
  return String(name || "lampiran-logbook")
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "lampiran-logbook";
}

function resolveLogbookAttachmentPath(fileUrl) {
  const normalizedUrl = String(fileUrl || "").trim();
  if (!normalizedUrl.startsWith("/uploads/logbooks/")) return null;
  return path.join(LOGBOOK_UPLOAD_DIR, normalizedUrl.replace("/uploads/logbooks/", ""));
}

async function removeLogbookAttachment(fileUrl) {
  const targetPath = resolveLogbookAttachmentPath(fileUrl);
  if (!targetPath) return;

  try {
    await fs.unlink(targetPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function saveLogbookAttachment(fileDataUrl, originalFileName) {
  const match = String(fileDataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    const error = new Error("Format lampiran tidak valid. Gunakan data URL base64.");
    error.statusCode = 400;
    throw error;
  }

  const mimeType = match[1];
  const base64Payload = match[2];
  const extension = ALLOWED_LOGBOOK_FILE_TYPES[mimeType];
  if (!extension) {
    const error = new Error("Tipe lampiran harus PDF, DOC, DOCX, JPG, PNG, atau ZIP.");
    error.statusCode = 400;
    throw error;
  }

  let buffer;
  try {
    buffer = Buffer.from(base64Payload, "base64");
  } catch {
    const error = new Error("Lampiran base64 tidak valid.");
    error.statusCode = 400;
    throw error;
  }

  if (!buffer || buffer.length === 0) {
    const error = new Error("Lampiran kosong tidak dapat diunggah.");
    error.statusCode = 400;
    throw error;
  }

  if (buffer.length > MAX_LOGBOOK_ATTACHMENT_SIZE) {
    const error = new Error("Ukuran lampiran maksimal 10 MB.");
    error.statusCode = 400;
    throw error;
  }

  await fs.mkdir(LOGBOOK_UPLOAD_DIR, { recursive: true });
  const baseName = sanitizeFilenameBase(originalFileName);
  const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${baseName}${extension}`;
  await fs.writeFile(path.join(LOGBOOK_UPLOAD_DIR, fileName), buffer);

  return {
    fileUrl: `/uploads/logbooks/${fileName}`,
    fileName: originalFileName || `${baseName}${extension}`,
    fileSize: buffer.length
  };
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    await ensureLogbookAttachmentColumns();
    const role = extractRole(req);
    let studentId = role === "mahasiswa" ? req.authUser?.id : req.query.studentId;
    const { projectId } = req.query;
    const normalizedProjectId = normalizeOptionalProjectId(projectId);

    // Resolve studentId if it's actually a user_id
    if (studentId) {
      studentId = await resolveStudentId(studentId) || studentId;
    }

    const { whereClause, params } = buildWhereClause([
      { value: studentId, sql: (index) => `le.student_id = $${index}` },
      { value: normalizedProjectId, sql: (index) => `le.project_id = $${index}` }
    ]);

    const result = await query(
      `
      SELECT le.id, le.student_id, su.name AS student_name, su.initials AS student_initials,
             le.project_id, COALESCE(rp.short_title, rp.title, 'Logbook Umum') AS project_name,
             le.date, le.title, le.description, le.output, le.kendala, le.has_attachment,
             le.file_url, le.file_name, le.file_size,
             le.created_at, le.updated_at,
             COALESCE(lc.comments, '[]'::json) AS comments,
             COALESCE(lc.comments_count, 0) AS comments_count,
             lv.detail->>'verificationStatus' AS verification_status,
             lv.detail->>'verificationNote' AS verification_note,
             vu.name AS verified_by_name,
             lv.logged_at AS verified_at
      FROM logbook_entries le
      JOIN students s ON s.id = le.student_id
      JOIN users su ON su.id = s.user_id
      LEFT JOIN research_projects rp ON rp.id = le.project_id
      LEFT JOIN LATERAL (
        SELECT
          json_agg(
            json_build_object(
              'id', lcm.id,
              'authorId', lcm.author_id,
              'authorName', COALESCE(lcm.author_name, au.name),
              'text', lcm.text,
              'createdAt', lcm.created_at
            )
            ORDER BY lcm.created_at DESC
          ) AS comments,
          COUNT(*)::int AS comments_count
        FROM logbook_comments lcm
        LEFT JOIN users au ON au.id = lcm.author_id
        WHERE lcm.logbook_entry_id = le.id
      ) lc ON TRUE
      LEFT JOIN LATERAL (
        SELECT al.user_id, al.detail, al.logged_at
        FROM audit_logs al
        WHERE al.target = 'Logbook'
          AND (al.detail->>'logbookId') = le.id
          AND al.detail ? 'verificationStatus'
        ORDER BY al.logged_at DESC
        LIMIT 1
      ) lv ON TRUE
      LEFT JOIN users vu ON vu.id = lv.user_id
      ${whereClause}
      ORDER BY le.date DESC, le.id DESC
      `,
      params
    );

    res.json(result.rows);
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    await ensureLogbookAttachmentColumns();
    const role = extractRole(req);
    if (role !== "mahasiswa") {
      return res.status(403).json({ message: "Hanya mahasiswa yang dapat menambah logbook." });
    }

    const {
      id,
      studentId,
      projectId,
      date,
      title,
      description,
      output,
      kendala,
      hasAttachment,
      fileDataUrl,
      fileName
    } = req.body;

    if (!id || !studentId || !date || !title || !description) {
      return res.status(400).json({ message: "id, studentId, date, title, description wajib diisi." });
    }

    // Validate against logged-in user (frontend sends user_id as studentId)
    if (String(studentId) !== String(req.authUser?.id)) {
      return res.status(403).json({ message: "studentId tidak sesuai akun login." });
    }

    // Resolve student_id: check if studentId is actually a user_id and find the real student.id
    const resolvedStudentId = await resolveStudentId(studentId);
    if (!resolvedStudentId) {
      return res.status(404).json({ message: "Data mahasiswa tidak ditemukan." });
    }

    let normalizedProjectId = null;
    try {
      normalizedProjectId = await ensureProjectCanBeUsed(projectId, resolvedStudentId);
    } catch (error) {
      return res.status(error?.statusCode || 400).json({ message: error?.message || "Riset tidak valid." });
    }

    let uploadedAttachment = null;
    if (typeof fileDataUrl === "string" && fileDataUrl.trim()) {
      try {
        uploadedAttachment = await saveLogbookAttachment(fileDataUrl.trim(), fileName);
      } catch (error) {
        const statusCode = error?.statusCode || 400;
        return res.status(statusCode).json({ message: error?.message || "Gagal upload lampiran logbook." });
      }
    }

    const hasStoredAttachment = uploadedAttachment ? true : Boolean(hasAttachment);

    await query(
      `
      INSERT INTO logbook_entries (
        id, student_id, project_id, date, title, description, output, kendala, has_attachment, file_url, file_name, file_size
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `,
      [
        id,
        resolvedStudentId,
        normalizedProjectId,
        date,
        title,
        description,
        output || null,
        kendala || null,
        hasStoredAttachment,
        uploadedAttachment?.fileUrl || null,
        uploadedAttachment?.fileName || null,
        uploadedAttachment?.fileSize || null
      ]
    );

    res.status(201).json({ message: "Entri logbook berhasil ditambahkan." });
  })
);

router.patch(
  "/:id/verify",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (!["operator", "dosen"].includes(role)) {
      return res.status(403).json({ message: "Hanya dosen/operator yang dapat memverifikasi logbook." });
    }

    const { verificationStatus, verificationNote, verifiedBy, verifiedByName } = req.body;

    if (!verificationStatus || !["Terverifikasi", "Perlu Revisi"].includes(verificationStatus)) {
      return res.status(400).json({ message: "verificationStatus harus Terverifikasi/Perlu Revisi." });
    }

    if (!verifiedBy) {
      return res.status(400).json({ message: "verifiedBy wajib diisi." });
    }
    const logbookId = requireSafeId(req.params.id, "id");

    const exists = await query("SELECT id FROM logbook_entries WHERE id = $1", [logbookId]);
    if (exists.rowCount === 0) {
      return res.status(404).json({ message: "Entri logbook tidak ditemukan." });
    }

    const auditId = `AL-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const roleLabel = role === "dosen" ? "Dosen" : "Operator";
    await query(
      `
      INSERT INTO audit_logs (id, user_id, user_role, action, target, ip, detail)
      VALUES ($1, $2, $3, 'Approve', 'Logbook', $4, $5)
      `,
      [
        auditId,
        verifiedBy,
        roleLabel,
        req.ip || null,
        {
          logbookId,
          verificationStatus,
          verificationNote: verificationNote || null,
          verifiedByName: verifiedByName || null
        }
      ]
    );

    res.json({ message: "Verifikasi logbook berhasil disimpan." });
  })
);

router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    await ensureLogbookAttachmentColumns();
    const logbookId = requireSafeId(req.params.id, "id");
    const body = req.body || {};
    const { projectId, date, title, description, output, kendala, hasAttachment, fileDataUrl, fileName, clearAttachment } = body;

    const existingEntry = await query(
      "SELECT id, student_id, project_id, file_url, file_name, file_size, has_attachment FROM logbook_entries WHERE id = $1 LIMIT 1",
      [logbookId]
    );

    if (existingEntry.rowCount === 0) {
      return res.status(404).json({ message: "Entri logbook tidak ditemukan." });
    }

    const hasProjectIdInput = Object.prototype.hasOwnProperty.call(body, "projectId");
    let nextProjectId = existingEntry.rows[0].project_id;
    if (hasProjectIdInput) {
      try {
        nextProjectId = await ensureProjectCanBeUsed(projectId, existingEntry.rows[0].student_id);
      } catch (error) {
        return res.status(error?.statusCode || 400).json({ message: error?.message || "Riset tidak valid." });
      }
    }

    let uploadedAttachment = null;
    if (typeof fileDataUrl === "string" && fileDataUrl.trim()) {
      try {
        uploadedAttachment = await saveLogbookAttachment(fileDataUrl.trim(), fileName);
      } catch (error) {
        const statusCode = error?.statusCode || 400;
        return res.status(statusCode).json({ message: error?.message || "Gagal upload lampiran logbook." });
      }
    }

    const shouldClearAttachment = Boolean(clearAttachment);
    const nextFileUrl = uploadedAttachment
      ? uploadedAttachment.fileUrl
      : (shouldClearAttachment ? null : existingEntry.rows[0].file_url);
    const nextFileName = uploadedAttachment
      ? uploadedAttachment.fileName
      : (shouldClearAttachment ? null : existingEntry.rows[0].file_name);
    const nextFileSize = uploadedAttachment
      ? uploadedAttachment.fileSize
      : (shouldClearAttachment ? null : existingEntry.rows[0].file_size);
    const nextHasAttachment = uploadedAttachment
      ? true
      : (shouldClearAttachment ? false : Boolean(nextFileUrl || hasAttachment || existingEntry.rows[0].has_attachment));

    const result = await query(
      `
      UPDATE logbook_entries
      SET project_id = $2,
          date = COALESCE($3, date),
          title = COALESCE($4, title),
          description = COALESCE($5, description),
          output = COALESCE($6, output),
          kendala = COALESCE($7, kendala),
          has_attachment = $8,
          file_url = $9,
          file_name = $10,
          file_size = $11,
          updated_at = NOW()
      WHERE id = $1
      RETURNING id
      `,
      [logbookId, nextProjectId, date, title, description, output, kendala, nextHasAttachment, nextFileUrl, nextFileName, nextFileSize]
    );

    try {
      if (uploadedAttachment && existingEntry.rows[0].file_url) {
        await removeLogbookAttachment(existingEntry.rows[0].file_url);
      } else if (shouldClearAttachment && existingEntry.rows[0].file_url) {
        await removeLogbookAttachment(existingEntry.rows[0].file_url);
      }
    } catch {
      // Metadata update is already persisted; ignore cleanup failure for now.
    }

    res.json({ message: "Entri logbook berhasil diperbarui." });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await ensureLogbookAttachmentColumns();
    const logbookId = requireSafeId(req.params.id, "id");

    const role = extractRole(req);
    if (!["mahasiswa", "operator"].includes(role)) {
      return res.status(403).json({ message: "Hanya mahasiswa atau operator yang dapat menghapus logbook." });
    }

    const existing = await query(
      "SELECT id, student_id, file_url FROM logbook_entries WHERE id = $1 LIMIT 1",
      [logbookId]
    );

    if (existing.rowCount === 0) {
      return res.status(404).json({ message: "Entri logbook tidak ditemukan." });
    }

    if (role === "mahasiswa") {
      const requesterUserId = String(req.authUser?.id || req.headers["x-user-id"] || req.query.userId || "").trim();
      const requesterStudentId = requesterUserId ? await resolveStudentId(requesterUserId) : null;
      if (!requesterStudentId || requesterStudentId !== existing.rows[0].student_id) {
        return res.status(403).json({ message: "Mahasiswa hanya boleh menghapus logbook miliknya sendiri." });
      }
    }

    await query("DELETE FROM logbook_entries WHERE id = $1", [logbookId]);

    try {
      await removeLogbookAttachment(existing.rows[0].file_url);
    } catch {
      // Deletion of DB record succeeded; ignore orphan cleanup failure.
    }

    res.json({ message: "Logbook berhasil dihapus." });
  })
);

router.post(
  "/:id/comments",
  asyncHandler(async (req, res) => {
    const { id, logbookId, authorId, authorName, text } = req.body;

    if (!id || !logbookId || !authorId || !text) {
      return res.status(400).json({ message: "id, logbookId, authorId, text wajib diisi." });
    }

    await query(
      `
      INSERT INTO logbook_comments (id, logbook_entry_id, author_id, author_name, text)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [id, logbookId, authorId, authorName || null, text]
    );

    res.status(201).json({ message: "Komentar berhasil ditambahkan." });
  })
);

router.delete(
  "/:logbookId/comments/:commentId",
  asyncHandler(async (req, res) => {
    const { logbookId, commentId } = req.params;
    const safeLogbookId = requireSafeId(logbookId, "logbookId");
    const safeCommentId = requireSafeId(commentId, "commentId");

    // Verify the comment belongs to the specified logbook entry
    const commentCheck = await query(
      "SELECT id FROM logbook_comments WHERE id = $1 AND logbook_entry_id = $2",
      [safeCommentId, safeLogbookId]
    );

    if (commentCheck.rowCount === 0) {
      return res.status(404).json({ message: "Komentar tidak ditemukan." });
    }

    await query("DELETE FROM logbook_comments WHERE id = $1", [safeCommentId]);

    res.json({ message: "Komentar berhasil dihapus." });
  })
);

module.exports = router;
