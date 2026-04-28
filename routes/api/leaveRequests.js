const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { buildWhereClause } = require("../../utils/queryFilters");
const { getSettingsAsync } = require("../../config/systemSettingsStore");
const { extractRole } = require("../../utils/roleGuard");
const { resolveStudentId } = require("../../utils/studentResolver");
const { createNotification } = require("../../utils/notificationService");

const router = express.Router();
let ensureLeaveColumnsPromise = null;

async function ensureLeaveColumns() {
  if (!ensureLeaveColumnsPromise) {
    ensureLeaveColumnsPromise = query(`
      ALTER TABLE leave_requests
      ADD COLUMN IF NOT EXISTS jenis_pengajuan TEXT NOT NULL DEFAULT 'cuti',
      ADD COLUMN IF NOT EXISTS counts_against_leave_quota BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS file_url TEXT,
      ADD COLUMN IF NOT EXISTS file_name TEXT
    `);
  }
  await ensureLeaveColumnsPromise;
}

function normalizeLeaveType(value) {
  const normalized = String(value || "cuti").trim().toLowerCase();
  return ["cuti", "izin", "sakit"].includes(normalized) ? normalized : null;
}

function getLeaveLabel(type) {
  if (type === "izin") return "izin";
  if (type === "sakit") return "sakit";
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
             lr.counts_against_leave_quota,
             lr.alasan, lr.catatan, lr.tanggal_pengajuan, lr.status,
             lr.reviewed_by, ru.name AS reviewed_by_name,
             lr.reviewed_at, lr.review_note,
             lr.file_url, lr.file_name
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

    res.json(result.rows);
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    await ensureLeaveColumns();
    const role = extractRole(req);

    if (role !== "mahasiswa") {
      return res.status(403).json({ message: "Hanya mahasiswa yang dapat membuat pengajuan cuti." });
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
      return res.status(400).json({ message: "Format tanggal cuti tidak valid." });
    }
    if (endDate < startDate) {
      return res.status(400).json({ message: "Tanggal selesai tidak boleh sebelum tanggal mulai." });
    }

    const requestedDays = inclusiveDays(startDate, endDate);
    const jenisPengajuan = normalizeLeaveType(jenisPengajuanInput || jenis);
    if (!jenisPengajuan) {
      return res.status(400).json({ message: "jenisPengajuan harus cuti, izin, atau sakit." });
    }

    const studentTypeResult = await query(
      `
      SELECT tipe
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

    const countsAgainstQuota = jenisPengajuan === "cuti" && countsAgainstLeaveQuota !== false;
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

    await query(
      `
      INSERT INTO leave_requests (
        id, student_id, project_id, periode_start, periode_end, durasi,
        jenis_pengajuan, counts_against_leave_quota,
        alasan, catatan, tanggal_pengajuan, status, file_url, file_name
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Menunggu',$12,$13)
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
        alasan,
        catatan || null,
        tanggalPengajuan,
        fileUrl || null,
        fileName || null
      ]
    );

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

    const { status, reviewedBy, reviewNote } = req.body;

    if (!status || !["Menunggu", "Disetujui", "Ditolak"].includes(status)) {
      return res.status(400).json({ message: "status harus Menunggu/Disetujui/Ditolak." });
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
      [req.params.id, status, reviewedBy || null, reviewNote || null]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Pengajuan cuti tidak ditemukan." });
    }

    const leaveRow = await query(
      `
      SELECT s.user_id, u.name AS student_name
      FROM leave_requests lr
      JOIN students s ON s.id = lr.student_id
      JOIN users u ON u.id = s.user_id
      WHERE lr.id = $1
      LIMIT 1
      `,
      [req.params.id]
    );

    const recipientUserId = leaveRow.rows[0]?.user_id;
    if (recipientUserId) {
      await createNotification({
        recipientUserId,
        title: "Status Cuti Diperbarui",
        body: `Pengajuan cuti Anda untuk ID ${req.params.id} telah ${status.toLowerCase()}.`,
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

    const result = await query("DELETE FROM leave_requests WHERE id = $1 RETURNING id", [req.params.id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Pengajuan cuti tidak ditemukan." });
    }

    res.json({ message: "Pengajuan cuti berhasil dihapus." });
  })
);

module.exports = router;