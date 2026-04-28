const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { buildWhereClause } = require("../../utils/queryFilters");
const { getSettingsAsync } = require("../../config/systemSettingsStore");
const { extractRole } = require("../../utils/roleGuard");
const { resolveStudentId } = require("../../utils/studentResolver");
const { createNotification } = require("../../utils/notificationService");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { requireSafeId } = require("../../utils/securityValidation");

const router = express.Router();
const LEAVE_REQUEST_UPLOAD_DIR = path.join(__dirname, "../../public/uploads/leave-requests");
const MAX_LEAVE_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const ALLOWED_LEAVE_ATTACHMENT_TYPES = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg"
};
let ensureLeaveColumnsPromise = null;

async function ensureLeaveColumns() {
  if (!ensureLeaveColumnsPromise) {
    ensureLeaveColumnsPromise = (async () => {
      await query(`
        ALTER TABLE students
        ADD COLUMN IF NOT EXISTS wfh_quota INTEGER NOT NULL DEFAULT 0
      `);
      await query(`
        ALTER TABLE leave_requests
        ADD COLUMN IF NOT EXISTS jenis_pengajuan TEXT NOT NULL DEFAULT 'cuti',
        ADD COLUMN IF NOT EXISTS counts_against_leave_quota BOOLEAN NOT NULL DEFAULT TRUE,
        ADD COLUMN IF NOT EXISTS counts_against_wfh_quota BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS file_url TEXT,
        ADD COLUMN IF NOT EXISTS file_name TEXT,
        ADD COLUMN IF NOT EXISTS file_size BIGINT
      `);
      await query(`
        ALTER TABLE leave_requests
        DROP CONSTRAINT IF EXISTS leave_requests_jenis_pengajuan_check,
        ADD CONSTRAINT leave_requests_jenis_pengajuan_check
          CHECK (jenis_pengajuan IN ('cuti', 'izin', 'sakit', 'wfh'))
      `);
    })();
  }
  await ensureLeaveColumnsPromise;
}

function normalizeLeaveType(value) {
  const normalized = String(value || "cuti").trim().toLowerCase();
  return ["cuti", "izin", "sakit", "wfh"].includes(normalized) ? normalized : null;
}

function getLeaveLabel(type) {
  if (type === "izin") return "izin";
  if (type === "sakit") return "sakit";
  if (type === "wfh") return "WFH";
  return "cuti";
}

function parseDateOnly(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function inclusiveDays(startDate, endDate) {
  const diffMs = endDate.getTime() - startDate.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;
}

function sanitizeFilenameBase(name) {
  return String(name || "lampiran-cuti")
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "lampiran-cuti";
}

function pickLeaveAttachment(body) {
  const candidates = [
    { dataUrl: body?.fileDataUrl, name: body?.fileName },
    { dataUrl: body?.attachmentDataUrl, name: body?.attachmentName },
    { dataUrl: body?.buktiPendukungDataUrl, name: body?.buktiPendukungName },
    { dataUrl: body?.lampiranDataUrl, name: body?.lampiranName }
  ];

  return candidates.find((item) => typeof item.dataUrl === "string" && item.dataUrl.trim()) || null;
}

async function saveLeaveAttachment(fileDataUrl, originalFileName) {
  const match = String(fileDataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    const error = new Error("Format lampiran tidak valid. Gunakan data URL base64.");
    error.statusCode = 400;
    throw error;
  }

  const mimeType = match[1];
  const base64Payload = match[2].replace(/\s/g, "");
  const extension = ALLOWED_LEAVE_ATTACHMENT_TYPES[mimeType];
  if (!extension) {
    const error = new Error("Tipe lampiran harus PDF, DOC, DOCX, PNG, atau JPG.");
    error.statusCode = 400;
    throw error;
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Payload) || base64Payload.length % 4 !== 0) {
    const error = new Error("Lampiran base64 tidak valid.");
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

  if (buffer.length > MAX_LEAVE_ATTACHMENT_SIZE) {
    const error = new Error("Ukuran lampiran maksimal 10 MB.");
    error.statusCode = 400;
    throw error;
  }

  await fs.mkdir(LEAVE_REQUEST_UPLOAD_DIR, { recursive: true });
  const baseName = sanitizeFilenameBase(originalFileName);
  const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${baseName}${extension}`;
  await fs.writeFile(path.join(LEAVE_REQUEST_UPLOAD_DIR, fileName), buffer);

  return {
    fileUrl: `/uploads/leave-requests/${fileName}`,
    fileName: originalFileName || `${baseName}${extension}`,
    fileSize: buffer.length
  };
}

function resolveLeaveAttachmentPath(fileUrl) {
  const normalizedUrl = String(fileUrl || "").trim();
  if (!normalizedUrl.startsWith("/uploads/leave-requests/")) return null;
  return path.join(LEAVE_REQUEST_UPLOAD_DIR, path.basename(normalizedUrl));
}

async function removeLeaveAttachment(fileUrl) {
  const targetPath = resolveLeaveAttachmentPath(fileUrl);
  if (!targetPath) return;

  try {
    await fs.unlink(targetPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function mapLeaveRequestRow(row) {
  return {
    ...row,
    counts_against_wfh_quota: Boolean(row.counts_against_wfh_quota),
    countsAgainstWfhQuota: Boolean(row.counts_against_wfh_quota),
    file_url: row.file_url || null,
    fileUrl: row.file_url || null,
    file_name: row.file_name || null,
    fileName: row.file_name || null
  };
}

async function countApprovedWfhRequests(studentId, excludeRequestId = null) {
  const result = await query(
    `
    SELECT COUNT(*)::int AS used
    FROM leave_requests
    WHERE student_id = $1
      AND status = 'Disetujui'
      AND jenis_pengajuan = 'wfh'
      AND counts_against_wfh_quota = TRUE
      AND ($2::text IS NULL OR id <> $2)
    `,
    [studentId, excludeRequestId || null]
  );

  return Number(result.rows[0]?.used || 0);
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    await ensureLeaveColumns();
    const role = extractRole(req);
    const requestedStudentId = req.query.studentId;
    const studentIdInput = requestedStudentId;
    const { status } = req.query;
    const resolvedStudentId = studentIdInput ? await resolveStudentId(String(studentIdInput)) : null;

    if (studentIdInput && !resolvedStudentId) {
      return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    }

    const { whereClause, params } = buildWhereClause([
      { value: status, sql: (index) => `lr.status = $${index}` },
      { value: resolvedStudentId, sql: (index) => `lr.student_id = $${index}` }
    ]);

    const result = await query(
      `
      SELECT lr.id, lr.student_id, su.name AS student_name, su.initials AS student_initials,
             s.nim, lr.project_id, rp.short_title AS project_name,
             lr.periode_start, lr.periode_end, lr.durasi,
             lr.jenis_pengajuan, lr.jenis_pengajuan AS jenis,
             lr.counts_against_leave_quota, lr.counts_against_wfh_quota,
             lr.alasan, lr.catatan, lr.tanggal_pengajuan, lr.status,
             lr.reviewed_by, ru.name AS reviewed_by_name,
             lr.reviewed_at, lr.review_note,
             lr.file_url, lr.file_name, lr.file_size
      FROM leave_requests lr
      JOIN students s ON s.id = lr.student_id
      JOIN users su ON su.id = s.user_id
      LEFT JOIN research_projects rp ON rp.id = lr.project_id
      LEFT JOIN users ru ON ru.id = lr.reviewed_by
      ${whereClause}
      ORDER BY lr.tanggal_pengajuan DESC, lr.id DESC
      `,
      params
    );

    res.json(result.rows.map(mapLeaveRequestRow));
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    await ensureLeaveColumns();
    const leaveRequestId = requireSafeId(req.params.id, "id");

    const result = await query(
      `
      SELECT lr.id, lr.student_id, su.name AS student_name, su.initials AS student_initials,
             s.nim, lr.project_id, rp.short_title AS project_name,
             lr.periode_start, lr.periode_end, lr.durasi,
             lr.jenis_pengajuan, lr.jenis_pengajuan AS jenis,
             lr.counts_against_leave_quota, lr.counts_against_wfh_quota,
             lr.alasan, lr.catatan, lr.tanggal_pengajuan, lr.status,
             lr.reviewed_by, ru.name AS reviewed_by_name,
             lr.reviewed_at, lr.review_note,
             lr.file_url, lr.file_name, lr.file_size
      FROM leave_requests lr
      JOIN students s ON s.id = lr.student_id
      JOIN users su ON su.id = s.user_id
      LEFT JOIN research_projects rp ON rp.id = lr.project_id
      LEFT JOIN users ru ON ru.id = lr.reviewed_by
      WHERE lr.id = $1
      LIMIT 1
      `,
      [leaveRequestId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Pengajuan cuti tidak ditemukan." });
    }

    res.json(mapLeaveRequestRow(result.rows[0]));
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    await ensureLeaveColumns();
    const role = extractRole(req);

    if (role !== "mahasiswa") {
      return res.status(403).json({ message: "Hanya mahasiswa yang dapat membuat pengajuan." });
    }

    const {
      id,
      studentId,
      projectId,
      periodeStart,
      periodeEnd,
      jenis,
      jenisPengajuan: jenisPengajuanInput,
      countsAgainstLeaveQuota,
      countsAgainstWfhQuota,
      alasan,
      catatan,
      tanggalPengajuan,
      fileUrl,
      fileName
    } = req.body;

    if (!id || !studentId || !periodeStart || !periodeEnd || !alasan || !tanggalPengajuan) {
      return res.status(400).json({ message: "id, studentId, periodeStart, periodeEnd, alasan, tanggalPengajuan wajib diisi." });
    }

    const resolvedStudentId = await resolveStudentId(String(studentId));
    if (!resolvedStudentId) {
      return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    }

    const startDate = parseDateOnly(periodeStart);
    const endDate = parseDateOnly(periodeEnd);
    if (!startDate || !endDate) {
      return res.status(400).json({ message: "Format tanggal pengajuan tidak valid." });
    }
    if (endDate < startDate) {
      return res.status(400).json({ message: "Tanggal selesai tidak boleh sebelum tanggal mulai." });
    }

    const requestedDays = inclusiveDays(startDate, endDate);
    const jenisPengajuan = normalizeLeaveType(jenisPengajuanInput || jenis);
    if (!jenisPengajuan) {
      return res.status(400).json({ message: "jenisPengajuan harus cuti, izin, sakit, atau wfh." });
    }

    const studentTypeResult = await query(
      `
      SELECT tipe, wfh_quota
      FROM students
      WHERE id = $1
      LIMIT 1
      `,
      [resolvedStudentId]
    );
    const studentType = studentTypeResult.rows[0]?.tipe;

    if (studentType === "Riset" && jenisPengajuan === "cuti") {
      return res.status(400).json({
        message: "Mahasiswa Riset tidak dapat mengajukan cuti. Silakan pilih izin atau sakit."
      });
    }

    if (jenisPengajuan === "wfh" && requestedDays !== 1) {
      return res.status(400).json({ message: "Pengajuan WFH hanya berlaku 1 hari." });
    }

    const wfhQuota = Number(studentTypeResult.rows[0]?.wfh_quota || 0);
    if (jenisPengajuan === "wfh") {
      if (wfhQuota <= 0) {
        return res.status(400).json({ message: "Anda tidak punya jatah WFH." });
      }

      const wfhUsed = await countApprovedWfhRequests(resolvedStudentId);
      if (wfhUsed >= wfhQuota) {
        return res.status(400).json({ message: "Jatah WFH tidak mencukupi." });
      }
    }

    const countsAgainstQuota = jenisPengajuan === "cuti" && countsAgainstLeaveQuota !== false;
    const countsAgainstWfh = jenisPengajuan === "wfh";
    const settings = await getSettingsAsync();
    const maxSemesterDays = Number(settings?.cuti?.maxSemesterDays || 0);
    const maxMonthDays = Number(settings?.cuti?.maxMonthDays || 0);
    const minAttendancePct = Number(settings?.cuti?.minAttendancePct || 0);

    if (countsAgainstQuota && maxSemesterDays > 0 && requestedDays > maxSemesterDays) {
      return res.status(400).json({ message: `Durasi cuti melebihi batas semester (${maxSemesterDays} hari).` });
    }

    if (countsAgainstQuota && maxMonthDays > 0 && requestedDays > maxMonthDays) {
      return res.status(400).json({ message: `Durasi cuti melebihi batas bulanan (${maxMonthDays} hari).` });
    }

    const monthStart = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, 0));

    if (countsAgainstQuota) {
      const monthUsageResult = await query(
        `
        SELECT COALESCE(SUM(durasi), 0)::int AS used_days
        FROM leave_requests
        WHERE student_id = $1
          AND status IN ('Menunggu', 'Disetujui')
          AND jenis_pengajuan = 'cuti'
          AND counts_against_leave_quota = TRUE
          AND periode_start <= $3
          AND periode_end >= $2
        `,
        [resolvedStudentId, monthStart.toISOString().slice(0, 10), monthEnd.toISOString().slice(0, 10)]
      );

      const usedMonthDays = Number(monthUsageResult.rows[0]?.used_days || 0);
      if (maxMonthDays > 0 && usedMonthDays + requestedDays > maxMonthDays) {
        return res.status(400).json({
          message: `Kuota cuti bulanan terlampaui. Sisa kuota bulan ini ${Math.max(0, maxMonthDays - usedMonthDays)} hari.`
        });
      }

      const semesterUsageResult = await query(
        `
        SELECT COALESCE(SUM(durasi), 0)::int AS used_days
        FROM leave_requests
        WHERE student_id = $1
          AND status IN ('Menunggu', 'Disetujui')
          AND jenis_pengajuan = 'cuti'
          AND counts_against_leave_quota = TRUE
          AND periode_start >= (CURRENT_DATE - INTERVAL '6 months')
        `,
        [resolvedStudentId]
      );

      const usedSemesterDays = Number(semesterUsageResult.rows[0]?.used_days || 0);
      if (maxSemesterDays > 0 && usedSemesterDays + requestedDays > maxSemesterDays) {
        return res.status(400).json({
          message: `Kuota cuti semester terlampaui. Sisa kuota semester ${Math.max(0, maxSemesterDays - usedSemesterDays)} hari.`
        });
      }
    }

    if (countsAgainstQuota && minAttendancePct > 0) {
      const attendanceResult = await query(
        `
        SELECT kehadiran, total_hari
        FROM students
        WHERE id = $1
        LIMIT 1
        `,
        [resolvedStudentId]
      );

      const studentRow = attendanceResult.rows[0] || {};
      const totalHari = Number(studentRow.total_hari || 0);
      const kehadiran = Number(studentRow.kehadiran || 0);
      const attendancePct = totalHari > 0 ? (kehadiran / totalHari) * 100 : 100;

      if (attendancePct < minAttendancePct) {
        return res.status(400).json({
          message: `Pengajuan ditolak. Kehadiran ${attendancePct.toFixed(1)}% masih di bawah batas minimum ${minAttendancePct}%.`
        });
      }
    }

    const attachmentInput = pickLeaveAttachment(req.body);
    let uploadedAttachment = null;
    if (attachmentInput) {
      try {
        uploadedAttachment = await saveLeaveAttachment(attachmentInput.dataUrl.trim(), attachmentInput.name);
      } catch (error) {
        const statusCode = error?.statusCode || 400;
        return res.status(statusCode).json({ message: error?.message || "Gagal upload lampiran pengajuan." });
      }
    }

    try {
      await query(
        `
        INSERT INTO leave_requests (
          id, student_id, project_id, periode_start, periode_end, durasi,
          jenis_pengajuan, counts_against_leave_quota, counts_against_wfh_quota,
          alasan, catatan, tanggal_pengajuan, status,
          file_url, file_name, file_size
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Menunggu',$13,$14,$15)
        `,
        [
          id,
          resolvedStudentId,
          projectId || null,
          periodeStart,
          periodeEnd,
          requestedDays,
          jenisPengajuan,
          countsAgainstQuota,
          countsAgainstWfh,
          alasan,
          catatan || null,
          tanggalPengajuan,
          uploadedAttachment?.fileUrl || null,
          uploadedAttachment?.fileName || null,
          uploadedAttachment?.fileSize || null
        ]
      );
    } catch (error) {
      if (uploadedAttachment?.fileUrl) {
        try {
          await removeLeaveAttachment(uploadedAttachment.fileUrl);
        } catch {
          // Preserve the original database error for the API response.
        }
      }
      throw error;
    }

    const studentNameResult = await query(
      `
      SELECT u.name
      FROM students s
      JOIN users u ON u.id = s.user_id
      WHERE s.id = $1
      LIMIT 1
      `,
      [resolvedStudentId]
    );

    const studentName = studentNameResult.rows[0]?.name || "Mahasiswa";
    const operatorsResult = await query("SELECT id FROM users WHERE role = 'operator' AND is_active = TRUE");

    await Promise.all(
      operatorsResult.rows.map((row) =>
        createNotification({
          recipientUserId: row.id,
          title: `Pengajuan ${getLeaveLabel(jenisPengajuan)} Baru`,
          body: `${studentName} mengajukan ${getLeaveLabel(jenisPengajuan)} ${requestedDays} hari (${periodeStart} s.d. ${periodeEnd}).`,
          senderUserId: null,
          type: "cuti",
          eventId: "cuti_request"
        })
      )
    );

    res.status(201).json({ message: "Pengajuan cuti berhasil dibuat." });
  })
);

router.patch(
  "/:id/status",
  asyncHandler(async (req, res) => {
    await ensureLeaveColumns();
    const role = extractRole(req);

    if (role !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat mengubah status cuti." });
    }

    const leaveRequestId = requireSafeId(req.params.id, "id");
    const { status, reviewedBy, reviewNote } = req.body;

    if (!status || !["Menunggu", "Disetujui", "Ditolak"].includes(status)) {
      return res.status(400).json({ message: "status harus Menunggu/Disetujui/Ditolak." });
    }

    const existingRequest = await query(
      `
      SELECT lr.id, lr.student_id, lr.jenis_pengajuan, lr.counts_against_wfh_quota,
             COALESCE(s.wfh_quota, 0)::int AS wfh_quota
      FROM leave_requests lr
      JOIN students s ON s.id = lr.student_id
      WHERE lr.id = $1
      LIMIT 1
      `,
      [leaveRequestId]
    );

    if (existingRequest.rowCount === 0) {
      return res.status(404).json({ message: "Pengajuan cuti tidak ditemukan." });
    }

    const requestRow = existingRequest.rows[0];
    if (status === "Disetujui" && requestRow.jenis_pengajuan === "wfh" && requestRow.counts_against_wfh_quota !== false) {
      const wfhQuota = Number(requestRow.wfh_quota || 0);
      const usedWfh = await countApprovedWfhRequests(requestRow.student_id, leaveRequestId);
      if (wfhQuota <= 0 || usedWfh + 1 > wfhQuota) {
        return res.status(400).json({ message: "Jatah WFH tidak mencukupi." });
      }
    }

    const result = await query(
      `
      UPDATE leave_requests
      SET status = $2,
          reviewed_by = COALESCE($3, reviewed_by),
          reviewed_at = NOW(),
          review_note = COALESCE($4, review_note),
          updated_at = NOW()
      WHERE id = $1
      RETURNING id
      `,
      [leaveRequestId, status, reviewedBy || null, reviewNote || null]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Pengajuan cuti tidak ditemukan." });
    }

    const leaveRow = await query(
      `
      SELECT s.user_id, u.name AS student_name, lr.jenis_pengajuan
      FROM leave_requests lr
      JOIN students s ON s.id = lr.student_id
      JOIN users u ON u.id = s.user_id
      WHERE lr.id = $1
      LIMIT 1
      `,
      [leaveRequestId]
    );

    const recipientUserId = leaveRow.rows[0]?.user_id;
    if (recipientUserId) {
      await createNotification({
        recipientUserId,
        title: `Status ${getLeaveLabel(leaveRow.rows[0]?.jenis_pengajuan)} Diperbarui`,
        body: `Pengajuan ${getLeaveLabel(leaveRow.rows[0]?.jenis_pengajuan)} Anda untuk ID ${leaveRequestId} telah ${status.toLowerCase()}.`,
        senderUserId: reviewedBy || null,
        type: "cuti",
        eventId: "cuti_request"
      });
    }

    res.json({ message: "Status cuti berhasil diperbarui." });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await ensureLeaveColumns();
    const role = extractRole(req);

    if (role !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat menghapus pengajuan cuti." });
    }

    const leaveRequestId = requireSafeId(req.params.id, "id");
    const result = await query("DELETE FROM leave_requests WHERE id = $1 RETURNING id, file_url", [leaveRequestId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Pengajuan cuti tidak ditemukan." });
    }

    try {
      await removeLeaveAttachment(result.rows[0].file_url);
    } catch {
      // The row is already deleted; ignore attachment cleanup failure.
    }

    res.json({ message: "Pengajuan cuti berhasil dihapus." });
  })
);

module.exports = router;