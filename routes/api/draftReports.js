const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { extractRole } = require("../../utils/roleGuard");
const { resolveStudentId, resolveStudentRecord } = require("../../utils/studentResolver");
const {
  DEFAULT_DRAFT_REPORT_TYPES,
  getDraftReportTypeLabels
} = require("../../utils/draftReportTypes");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();

const LEGACY_DRAFT_TYPES = DEFAULT_DRAFT_REPORT_TYPES.map((item) => item.label);
const DRAFT_STATUSES = ["Menunggu Review", "Dalam Review", "Disetujui"];
const DRAFT_UPLOAD_DIR = path.join(__dirname, "../../public/uploads/drafts");
const MAX_DRAFT_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_DRAFT_FILE_TYPES = {
  "application/pdf": { extension: ".pdf", format: "PDF" },
  "application/msword": { extension: ".doc", format: "DOC" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { extension: ".docx", format: "DOCX" }
};
let ensureDraftReportsPromise = null;

function resolveRequesterUserId(req) {
  return String(
    req?.authUser?.id ||
      req.headers["x-user-id"] ||
      req.query.userId ||
      req.body?.userId ||
      ""
  ).trim();
}

async function ensureDraftReportsTable() {
  if (!ensureDraftReportsPromise) {
    ensureDraftReportsPromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS draft_reports (
          id TEXT PRIMARY KEY,
          student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          project_id TEXT REFERENCES research_projects(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('Laporan TA', 'Jurnal', 'Laporan Kemajuan')),
          upload_date DATE NOT NULL DEFAULT CURRENT_DATE,
          status TEXT NOT NULL CHECK (status IN ('Menunggu Review', 'Dalam Review', 'Disetujui')) DEFAULT 'Menunggu Review',
          comment TEXT,
          version TEXT NOT NULL DEFAULT 'v1.0',
          file_url TEXT,
          file_name TEXT,
          file_size BIGINT,
          mime_type TEXT,
          reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          reviewed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_draft_reports_student_upload
        ON draft_reports(student_id, upload_date DESC, updated_at DESC)
      `);
    })().catch((error) => {
      ensureDraftReportsPromise = null;
      throw error;
    });
  }

  await ensureDraftReportsPromise;
}

function sanitizeFilenameBase(name) {
  return String(name || "draft-mahasiswa")
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "draft-mahasiswa";
}

function resolveDraftAttachmentPath(fileUrl) {
  const normalizedUrl = String(fileUrl || "").trim();
  if (!normalizedUrl.startsWith("/uploads/drafts/")) return null;
  return path.join(DRAFT_UPLOAD_DIR, normalizedUrl.replace("/uploads/drafts/", ""));
}

async function removeDraftAttachment(fileUrl) {
  const targetPath = resolveDraftAttachmentPath(fileUrl);
  if (!targetPath) return;

  try {
    await fs.unlink(targetPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function saveDraftAttachment(fileDataUrl, originalFileName) {
  const match = String(fileDataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    const error = new Error("Format file draft tidak valid. Gunakan data URL base64.");
    error.statusCode = 400;
    throw error;
  }

  const mimeType = match[1];
  const base64Payload = match[2];
  const allowedType = ALLOWED_DRAFT_FILE_TYPES[mimeType];
  if (!allowedType) {
    const error = new Error("Tipe file draft harus PDF, DOC, atau DOCX.");
    error.statusCode = 400;
    throw error;
  }

  let buffer;
  try {
    buffer = Buffer.from(base64Payload, "base64");
  } catch {
    const error = new Error("File draft base64 tidak valid.");
    error.statusCode = 400;
    throw error;
  }

  if (!buffer || buffer.length === 0) {
    const error = new Error("File draft kosong tidak dapat diunggah.");
    error.statusCode = 400;
    throw error;
  }

  if (buffer.length > MAX_DRAFT_FILE_SIZE) {
    const error = new Error("Ukuran file draft maksimal 10 MB.");
    error.statusCode = 400;
    throw error;
  }

  await fs.mkdir(DRAFT_UPLOAD_DIR, { recursive: true });
  const baseName = sanitizeFilenameBase(originalFileName);
  const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${baseName}${allowedType.extension}`;
  await fs.writeFile(path.join(DRAFT_UPLOAD_DIR, fileName), buffer);

  return {
    fileUrl: `/uploads/drafts/${fileName}`,
    fileName: originalFileName || `${baseName}${allowedType.extension}`,
    fileSize: buffer.length,
    mimeType
  };
}

function formatFileSize(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }

  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${bytes} B`;
}

function getDraftFormat(mimeType, fileName) {
  const matchedMimeType = ALLOWED_DRAFT_FILE_TYPES[String(mimeType || "").trim()];
  if (matchedMimeType) {
    return matchedMimeType.format;
  }

  const extension = path.extname(String(fileName || "")).replace(".", "").trim().toUpperCase();
  return extension || null;
}

function formatDateForResponse(value) {
  if (!value) return null;
  return new Date(value).toLocaleDateString("id-ID");
}

function incrementDraftVersion(version) {
  const match = String(version || "").trim().match(/^v(\d+)\.(\d+)$/i);
  if (!match) {
    return "v1.1";
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return "v1.1";
  }

  return `v${major}.${minor + 1}`;
}

function buildDraftReportIdCandidate(sequence) {
  const now = new Date();
  const datePart = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("");

  return `DRF-${datePart}-${String(sequence).padStart(3, "0")}`;
}

async function generateDraftReportId() {
  const result = await query(
    `
    SELECT id
    FROM draft_reports
    WHERE id LIKE $1
    ORDER BY id DESC
    LIMIT 1
    `,
    [`DRF-${[
      new Date().getFullYear(),
      String(new Date().getMonth() + 1).padStart(2, "0"),
      String(new Date().getDate()).padStart(2, "0")
    ].join("")}-%`]
  );

  if (result.rowCount === 0) {
    return buildDraftReportIdCandidate(1);
  }

  const match = String(result.rows[0].id || "").match(/-(\d+)$/);
  const nextSequence = match ? Number(match[1]) + 1 : 1;
  return buildDraftReportIdCandidate(nextSequence);
}

async function ensureResearchProjectExists(projectId) {
  if (!projectId) return;

  const result = await query(
    "SELECT id FROM research_projects WHERE id = $1 LIMIT 1",
    [projectId]
  );

  if (result.rowCount === 0) {
    const error = new Error("Riset yang dipilih tidak ditemukan.");
    error.statusCode = 404;
    throw error;
  }
}

async function resolveManagedStudent(studentIdOrUserId, requesterUserId, enforceOwnership) {
  const student = await resolveStudentRecord(studentIdOrUserId);
  if (!student) {
    const error = new Error("Data mahasiswa tidak ditemukan.");
    error.statusCode = 404;
    throw error;
  }

  if (enforceOwnership && requesterUserId && String(student.user_id) !== String(requesterUserId)) {
    const error = new Error("studentId tidak sesuai akun login.");
    error.statusCode = 403;
    throw error;
  }

  return student;
}

function mapPersistentDraftRow(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: row.student_name,
    title: row.title,
    type: row.type,
    uploadDate: formatDateForResponse(row.upload_date),
    fileSize: formatFileSize(row.file_size),
    format: getDraftFormat(row.mime_type, row.file_name),
    status: row.status,
    comment: row.comment || null,
    riset: row.riset || "Riset",
    version: row.version || "v1.0",
    reviewedBy: row.reviewed_by_name || null,
    reviewedAt: row.reviewed_at || null,
    file_url: row.file_url || null,
    file_name: row.file_name || null,
    file_size: row.file_size ?? null,
    mime_type: row.mime_type || null,
    projectId: row.project_id || null,
    _sortDate: row.upload_date || row.reviewed_at || row.updated_at || null
  };
}

function sanitizeDraftResponse(row) {
  if (!row) return row;
  const { _sortDate, ...data } = row;
  return data;
}

async function fetchPersistentDraftById(id) {
  const result = await query(
    `
    SELECT dr.id, dr.student_id, dr.project_id, su.name AS student_name,
           dr.title, dr.type, dr.upload_date, dr.status, dr.comment,
           dr.version, dr.file_url, dr.file_name, dr.file_size, dr.mime_type,
           COALESCE(rp.short_title, rp.title) AS riset,
           reviewer.name AS reviewed_by_name, dr.reviewed_at
    FROM draft_reports dr
    JOIN students s ON s.id = dr.student_id
    JOIN users su ON su.id = s.user_id
    LEFT JOIN research_projects rp ON rp.id = dr.project_id
    LEFT JOIN users reviewer ON reviewer.id = dr.reviewed_by
    WHERE dr.id = $1
    LIMIT 1
    `,
    [id]
  );

  if (result.rowCount === 0) return null;
  return sanitizeDraftResponse(mapPersistentDraftRow(result.rows[0]));
}

async function getLegacyDraftReports(studentId, type, projectId) {
  const result = await query(
    `
    SELECT le.id, le.student_id, su.name AS student_name, le.title, le.date,
           COALESCE(rp.short_title, rp.title) AS riset, le.project_id,
           le.file_url, le.file_name, le.file_size
    FROM logbook_entries le
    JOIN students s ON s.id = le.student_id
    JOIN users su ON su.id = s.user_id
    LEFT JOIN research_projects rp ON rp.id = le.project_id
    WHERE le.student_id = $1
      AND ($2::text IS NULL OR le.project_id = $2)
    ORDER BY le.date DESC, le.id DESC
    LIMIT 30
    `,
    [studentId, projectId || null]
  );

  const reviewResult = await query(
    `
    SELECT al.detail->>'draftId' AS draft_id,
           al.detail->>'status' AS status,
           al.detail->>'note' AS note,
           al.detail->>'reviewedByName' AS reviewed_by_name,
           al.logged_at
    FROM audit_logs al
    WHERE al.target = 'DraftReport'
      AND (al.detail->>'studentId') = $1
    ORDER BY al.logged_at DESC
    `,
    [studentId]
  );

  const latestReviewByDraft = new Map();
  reviewResult.rows.forEach((row) => {
    if (!latestReviewByDraft.has(row.draft_id)) {
      latestReviewByDraft.set(row.draft_id, row);
    }
  });

  let rows = result.rows.map((item, index) => {
    const draftType = LEGACY_DRAFT_TYPES[index % LEGACY_DRAFT_TYPES.length];
    const defaultStatus = DRAFT_STATUSES[index % DRAFT_STATUSES.length];
    const draftId = `D-${item.id}`;
    const reviewed = latestReviewByDraft.get(draftId);
    return {
      id: draftId,
      studentId: item.student_id,
      studentName: item.student_name,
      title: item.title,
      type: draftType,
      uploadDate: formatDateForResponse(item.date),
      fileSize: formatFileSize(item.file_size) || `${(1.2 + (index % 5) * 0.6).toFixed(1)} MB`,
      format: getDraftFormat(null, item.file_name) || "PDF",
      status: reviewed?.status || defaultStatus,
      comment:
        reviewed?.note ||
        (defaultStatus === "Disetujui"
          ? "Dokumen sudah memenuhi ketentuan dan siap dipublikasikan."
          : defaultStatus === "Dalam Review"
            ? "Sedang ditinjau dosen pembimbing."
            : null),
      riset: item.riset || "Riset",
      version: `v${1 + (index % 3)}.${index % 10}`,
      reviewedBy: reviewed?.reviewed_by_name || null,
      reviewedAt: reviewed?.logged_at || null,
      file_url: item.file_url || null,
      file_name: item.file_name || null,
      file_size: item.file_size ?? null,
      mime_type: null,
      projectId: item.project_id || null,
      _sortDate: item.date || reviewed?.logged_at || null
    };
  });

  if (type !== "Semua") {
    rows = rows.filter((item) => item.type === type);
  }

  return rows;
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    await ensureDraftReportsTable();
    const role = extractRole(req);
    const requesterUserId = resolveRequesterUserId(req);
    const { type = "Semua", projectId } = req.query;
    const requestedStudentId = req.query.studentId || (role === "mahasiswa" ? requesterUserId : null);

    if (!requestedStudentId) {
      return res.status(400).json({ message: "studentId wajib diisi." });
    }

    const configuredDraftTypes = await getDraftReportTypeLabels({ activeOnly: false });
    if (type !== "Semua" && !configuredDraftTypes.includes(type)) {
      return res.status(400).json({ message: "type draft tidak valid." });
    }

    const student = await resolveManagedStudent(
      requestedStudentId,
      requesterUserId,
      role === "mahasiswa"
    );

    const persistentResult = await query(
      `
      SELECT dr.id, dr.student_id, dr.project_id, su.name AS student_name,
             dr.title, dr.type, dr.upload_date, dr.status, dr.comment,
             dr.version, dr.file_url, dr.file_name, dr.file_size, dr.mime_type,
             COALESCE(rp.short_title, rp.title) AS riset,
             reviewer.name AS reviewed_by_name, dr.reviewed_at,
             dr.updated_at
      FROM draft_reports dr
      JOIN students s ON s.id = dr.student_id
      JOIN users su ON su.id = s.user_id
      LEFT JOIN research_projects rp ON rp.id = dr.project_id
      LEFT JOIN users reviewer ON reviewer.id = dr.reviewed_by
      WHERE dr.student_id = $1
        AND ($2::text = 'Semua' OR dr.type = $2)
        AND ($3::text IS NULL OR dr.project_id = $3)
      ORDER BY dr.upload_date DESC, dr.updated_at DESC, dr.id DESC
      `,
      [student.id, type, projectId || null]
    );

    const persistentRows = persistentResult.rows.map(mapPersistentDraftRow);
    const legacyRows = await getLegacyDraftReports(student.id, type, projectId);
    const persistentIds = new Set(persistentRows.map((item) => item.id));
    const rows = [...persistentRows, ...legacyRows.filter((item) => !persistentIds.has(item.id))];

    rows.sort((left, right) => {
      const leftTime = left._sortDate ? new Date(left._sortDate).getTime() : 0;
      const rightTime = right._sortDate ? new Date(right._sortDate).getTime() : 0;
      return rightTime - leftTime;
    });

    res.json(rows.map(sanitizeDraftResponse));
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    await ensureDraftReportsTable();
    const role = extractRole(req);
    const requesterUserId = resolveRequesterUserId(req);
    if (role && role !== "mahasiswa") {
      return res.status(403).json({ message: "Hanya mahasiswa yang dapat mengunggah draft." });
    }

    const { id, studentId, projectId, title, type, fileName, fileDataUrl } = req.body;
    if (!studentId || !projectId || !title || !type || !fileName || !fileDataUrl) {
      return res.status(400).json({
        message: "studentId, projectId, title, type, fileName, dan fileDataUrl wajib diisi."
      });
    }

    const configuredDraftTypes = await getDraftReportTypeLabels({ activeOnly: true });
    if (!configuredDraftTypes.includes(type)) {
      return res.status(400).json({ message: "type draft tidak valid." });
    }

    const student = await resolveManagedStudent(studentId, requesterUserId, Boolean(requesterUserId));
    await ensureResearchProjectExists(projectId);

    const draftId = id || await generateDraftReportId();
    if (id) {
      const existingDraft = await query("SELECT id FROM draft_reports WHERE id = $1 LIMIT 1", [id]);
      if (existingDraft.rowCount > 0) {
        return res.status(409).json({ message: "ID draft report sudah digunakan." });
      }
    }

    let uploadedAttachment;
    try {
      uploadedAttachment = await saveDraftAttachment(fileDataUrl, fileName);
    } catch (error) {
      return res.status(error?.statusCode || 400).json({
        message: error?.message || "Gagal upload file draft."
      });
    }

    await query(
      `
      INSERT INTO draft_reports (
        id, student_id, project_id, title, type, upload_date, status, comment,
        version, file_url, file_name, file_size, mime_type
      ) VALUES (
        $1, $2, $3, $4, $5, CURRENT_DATE, 'Menunggu Review', NULL,
        'v1.0', $6, $7, $8, $9
      )
      `,
      [
        draftId,
        student.id,
        projectId,
        title,
        type,
        uploadedAttachment.fileUrl,
        uploadedAttachment.fileName,
        uploadedAttachment.fileSize,
        uploadedAttachment.mimeType
      ]
    );

    const createdDraft = await fetchPersistentDraftById(draftId);
    res.status(201).json({
      message: "Draft report berhasil diunggah.",
      data: sanitizeDraftResponse(createdDraft)
    });
  })
);

router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    await ensureDraftReportsTable();
    const role = extractRole(req);
    const requesterUserId = resolveRequesterUserId(req);
    if (role && role !== "mahasiswa") {
      return res.status(403).json({ message: "Hanya mahasiswa yang dapat memperbarui draft." });
    }

    const { title, type, projectId, fileName, fileDataUrl, clearAttachment } = req.body;
    const configuredDraftTypes = await getDraftReportTypeLabels({ activeOnly: true });
    if (type && !configuredDraftTypes.includes(type)) {
      return res.status(400).json({ message: "type draft tidak valid." });
    }

    const existingDraftResult = await query(
      `
      SELECT dr.id, dr.student_id, dr.project_id, dr.title, dr.type, dr.version,
             dr.file_url, dr.file_name, dr.file_size, dr.mime_type, s.user_id
      FROM draft_reports dr
      JOIN students s ON s.id = dr.student_id
      WHERE dr.id = $1
      LIMIT 1
      `,
      [req.params.id]
    );

    if (existingDraftResult.rowCount === 0) {
      return res.status(404).json({ message: "Draft report tidak ditemukan." });
    }

    const existingDraft = existingDraftResult.rows[0];
    if (requesterUserId && String(existingDraft.user_id) !== String(requesterUserId)) {
      return res.status(403).json({ message: "Draft report bukan milik akun login." });
    }

    await ensureResearchProjectExists(projectId || existingDraft.project_id);

    let uploadedAttachment = null;
    if (typeof fileDataUrl === "string" && fileDataUrl.trim()) {
      try {
        uploadedAttachment = await saveDraftAttachment(fileDataUrl.trim(), fileName);
      } catch (error) {
        return res.status(error?.statusCode || 400).json({
          message: error?.message || "Gagal upload file draft."
        });
      }
    }

    const shouldClearAttachment = Boolean(clearAttachment);
    const nextFileUrl = uploadedAttachment
      ? uploadedAttachment.fileUrl
      : (shouldClearAttachment ? null : existingDraft.file_url);
    const nextFileName = uploadedAttachment
      ? uploadedAttachment.fileName
      : (shouldClearAttachment ? null : existingDraft.file_name);
    const nextFileSize = uploadedAttachment
      ? uploadedAttachment.fileSize
      : (shouldClearAttachment ? null : existingDraft.file_size);
    const nextMimeType = uploadedAttachment
      ? uploadedAttachment.mimeType
      : (shouldClearAttachment ? null : existingDraft.mime_type);
    const nextVersion = incrementDraftVersion(existingDraft.version);

    await query(
      `
      UPDATE draft_reports
      SET project_id = COALESCE($2, project_id),
          title = COALESCE($3, title),
          type = COALESCE($4, type),
          upload_date = CURRENT_DATE,
          status = 'Menunggu Review',
          comment = NULL,
          version = $5,
          file_url = $6,
          file_name = $7,
          file_size = $8,
          mime_type = $9,
          reviewed_by = NULL,
          reviewed_at = NULL,
          updated_at = NOW()
      WHERE id = $1
      `,
      [
        req.params.id,
        projectId || null,
        title || null,
        type || null,
        nextVersion,
        nextFileUrl,
        nextFileName,
        nextFileSize,
        nextMimeType
      ]
    );

    try {
      if (uploadedAttachment && existingDraft.file_url) {
        await removeDraftAttachment(existingDraft.file_url);
      } else if (shouldClearAttachment && existingDraft.file_url) {
        await removeDraftAttachment(existingDraft.file_url);
      }
    } catch {
      // Metadata update already persisted; ignore orphan cleanup failures.
    }

    const updatedDraft = await fetchPersistentDraftById(req.params.id);
    res.json({
      message: "Draft report berhasil diperbarui.",
      data: sanitizeDraftResponse(updatedDraft)
    });
  })
);

router.patch(
  "/:id/review",
  asyncHandler(async (req, res) => {
    await ensureDraftReportsTable();
    const { status, note, reviewedBy, reviewedByName, studentId } = req.body;

    if (!status || !DRAFT_STATUSES.includes(status)) {
      return res.status(400).json({ message: "status review tidak valid." });
    }

    if (!reviewedBy) {
      return res.status(400).json({ message: "reviewedBy wajib diisi." });
    }

    const persistedDraft = await query(
      "SELECT id, student_id FROM draft_reports WHERE id = $1 LIMIT 1",
      [req.params.id]
    );
    const resolvedStudentId = studentId ? await resolveStudentId(studentId) : null;
    const effectiveStudentId = resolvedStudentId || persistedDraft.rows[0]?.student_id || null;

    if (!effectiveStudentId) {
      return res.status(400).json({ message: "studentId wajib diisi." });
    }

    if (persistedDraft.rowCount > 0) {
      await query(
        `
        UPDATE draft_reports
        SET status = $2,
            comment = $3,
            reviewed_by = $4,
            reviewed_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
        `,
        [req.params.id, status, note || null, reviewedBy]
      );
    }

    const auditId = `AL-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    await query(
      `
      INSERT INTO audit_logs (id, user_id, user_role, action, target, ip, detail)
      VALUES ($1, $2, 'Dosen', 'Update', 'DraftReport', $3, $4)
      `,
      [
        auditId,
        reviewedBy,
        req.ip || null,
        {
          draftId: req.params.id,
          studentId: effectiveStudentId,
          status,
          note: note || null,
          reviewedByName: reviewedByName || null
        }
      ]
    );

    res.json({ message: "Review draft berhasil disimpan." });
  })
);

module.exports = router;
