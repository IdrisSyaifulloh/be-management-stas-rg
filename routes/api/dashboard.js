const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { getSettingsAsync } = require("../../config/systemSettingsStore");
const { extractRole } = require("../../utils/roleGuard");
const {
  buildReminderIdentity,
  ensureDashboardReminderTable,
  ensureDashboardWarningReviewTable,
  findExistingDashboardWarningReview,
  normalizeDashboardReminderType,
  recordDashboardWarningReview,
  resolveDashboardReminderStudentId
} = require("../../utils/dashboardReminders");
const { createAttendanceAbsentLocks } = require("../../utils/studentAccessLocks");

const router = express.Router();
const DASHBOARD_TIMEZONE = "Asia/Jakarta";
const ATTENDANCE_ABSENT_VISIBLE_AFTER = "10:00";

function getJakartaNowParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: DASHBOARD_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23"
  });

  const parts = formatter.formatToParts(date).reduce((acc, item) => {
    acc[item.type] = item.value;
    return acc;
  }, {});

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`
  };
}

function isAfterAttendanceCutoff(time) {
  return String(time || "") >= ATTENDANCE_ABSENT_VISIBLE_AFTER;
}

router.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Akses ditolak. Ringkasan dashboard hanya untuk operator." });
    }

    const [students, lecturers, research, leavePending, lettersPending, latestLogbooks] = await Promise.all([
      query("SELECT COUNT(*)::int AS total FROM students"),
      query("SELECT COUNT(*)::int AS total FROM lecturers"),
      query("SELECT COUNT(*)::int AS total FROM research_projects WHERE status = 'Aktif'"),
      query("SELECT COUNT(*)::int AS total FROM leave_requests WHERE status = 'Menunggu'"),
      query("SELECT COUNT(*)::int AS total FROM letter_requests WHERE status = 'Menunggu'"),
      query(
        `
        SELECT le.id, le.date, le.title, su.name AS student_name, rp.short_title AS project_name
        FROM logbook_entries le
        JOIN students s ON s.id = le.student_id
        JOIN users su ON su.id = s.user_id
        LEFT JOIN research_projects rp ON rp.id = le.project_id
        ORDER BY le.date DESC, le.id DESC
        LIMIT 5
        `
      )
    ]);

    res.json({
      totalMahasiswa: students.rows[0].total,
      totalDosen: lecturers.rows[0].total,
      totalRisetAktif: research.rows[0].total,
      cutiMenunggu: leavePending.rows[0].total,
      suratMenunggu: lettersPending.rows[0].total,
      logbookTerbaru: latestLogbooks.rows
    });
  })
);

router.get(
  "/operator-warnings",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Akses ditolak. Warning dashboard operator hanya untuk operator." });
    }

    await ensureDashboardReminderTable();
    await ensureDashboardWarningReviewTable();

    const nowParts = getJakartaNowParts();
    const attendanceSectionActive = isAfterAttendanceCutoff(nowParts.time);
    const calendarResult = await query(
      `
      SELECT to_char($1::date, 'IYYY-"W"IW') AS week_key
      `,
      [nowParts.date]
    );
    const today = nowParts.date;
    const weekKey = calendarResult.rows[0]?.week_key;

    const [logbookMissingRows, attendanceAbsentRows, lowHoursRows] = await Promise.all([
      query(
        `
        SELECT
          s.id AS student_id,
          s.user_id AS recipient_user_id,
          u.name AS student_name,
          u.initials AS student_initials,
          s.nim,
          $1::date AS reference_date
        FROM students s
        JOIN users u ON u.id = s.user_id
        WHERE s.status = 'Aktif'
          AND NOT EXISTS (
            SELECT 1
            FROM logbook_entries le
            WHERE le.student_id = s.id
              AND le.date = $1::date
          )
          AND NOT EXISTS (
            SELECT 1
            FROM dashboard_reminder_logs dr
            WHERE dr.student_id = s.id
              AND dr.type = 'logbook_missing'
              AND dr.reference_date = $1::date
          )
          AND NOT EXISTS (
            SELECT 1
            FROM dashboard_warning_reviews dwr
            WHERE dwr.student_id = s.id
              AND dwr.type = 'logbook_missing'
              AND dwr.reference_date = $1::date
          )
        ORDER BY u.name ASC
        `,
        [today]
      ),
      attendanceSectionActive
        ? query(
            `
            SELECT
              s.id AS student_id,
              s.user_id AS recipient_user_id,
              u.name AS student_name,
              u.initials AS student_initials,
              s.nim,
              COALESCE(ar.status, 'Belum Absen') AS attendance_status,
              $1::date AS reference_date
            FROM students s
            JOIN users u ON u.id = s.user_id
            LEFT JOIN attendance_records ar
              ON ar.student_id = s.id
             AND ar.attendance_date = $1::date
            WHERE s.status = 'Aktif'
              AND COALESCE(ar.status, 'Belum Absen') NOT IN ('Hadir', 'Cuti')
              AND NOT EXISTS (
                SELECT 1
                FROM dashboard_warning_reviews dwr
                WHERE dwr.student_id = s.id
                  AND dwr.type = 'attendance_absent'
                  AND dwr.reference_date = $1::date
              )
            ORDER BY u.name ASC
            `,
            [today]
          )
        : Promise.resolve({ rows: [] }),
      query(
        `
        SELECT
          s.id AS student_id,
          s.user_id AS recipient_user_id,
          u.name AS student_name,
          u.initials AS student_initials,
          s.nim,
          COALESCE(s.jam_minggu_ini, 0) AS current_hours,
          COALESCE(s.jam_minggu_target, 0) AS target_hours,
          $1::text AS reference_period
        FROM students s
        JOIN users u ON u.id = s.user_id
        WHERE s.status = 'Aktif'
          AND COALESCE(s.jam_minggu_target, 0) > 0
          AND COALESCE(s.jam_minggu_ini, 0) < COALESCE(s.jam_minggu_target, 0)
          AND NOT EXISTS (
            SELECT 1
            FROM dashboard_reminder_logs dr
            WHERE dr.student_id = s.id
              AND dr.type = 'low_hours'
              AND dr.reference_period = $1::text
          )
          AND NOT EXISTS (
            SELECT 1
            FROM dashboard_warning_reviews dwr
            WHERE dwr.student_id = s.id
              AND dwr.type = 'low_hours'
              AND dwr.reference_period = $1::text
          )
        ORDER BY COALESCE(s.jam_minggu_ini, 0) ASC, u.name ASC
        `,
        [weekKey]
      )
    ]);

    const mapWarningItem = (row, type) => ({
      id: `${type}:${row.student_id}:${row.reference_date || row.reference_period}`,
      type,
      student_id: row.student_id,
      studentId: row.student_id,
      recipient_user_id: row.recipient_user_id,
      recipientUserId: row.recipient_user_id,
      student_name: row.student_name,
      studentName: row.student_name,
      student_initials: row.student_initials,
      studentInitials: row.student_initials,
      nim: row.nim,
      reference_date: row.reference_date || null,
      referenceDate: row.reference_date || null,
      reference_period: row.reference_period || null,
      referencePeriod: row.reference_period || null,
      attendance_status: row.attendance_status || null,
      attendanceStatus: row.attendance_status || null,
      can_send_notification: type !== "attendance_absent",
      canSendNotification: type !== "attendance_absent",
      can_review: type === "attendance_absent",
      canReview: type === "attendance_absent",
      current_hours: row.current_hours != null ? Number(row.current_hours) : null,
      currentHours: row.current_hours != null ? Number(row.current_hours) : null,
      target_hours: row.target_hours != null ? Number(row.target_hours) : null,
      targetHours: row.target_hours != null ? Number(row.target_hours) : null
    });

    const warnings = {
      logbookMissing: logbookMissingRows.rows.map((row) => mapWarningItem(row, "logbook_missing")),
      attendanceAbsent: attendanceSectionActive
        ? attendanceAbsentRows.rows.map((row) => mapWarningItem(row, "attendance_absent"))
        : [],
      lowHours: lowHoursRows.rows.map((row) => mapWarningItem(row, "low_hours"))
    };

    if (attendanceSectionActive && warnings.attendanceAbsent.length > 0) {
      await createAttendanceAbsentLocks({
        studentIds: warnings.attendanceAbsent.map((item) => item.studentId),
        date: today
      });
    }

    res.json({
      generatedAt: new Date().toISOString(),
      referenceDate: today,
      referencePeriod: weekKey,
      meta: {
        timezone: DASHBOARD_TIMEZONE,
        attendanceAbsent: {
          visibleAfter: ATTENDANCE_ABSENT_VISIBLE_AFTER,
          active: attendanceSectionActive,
          notificationEnabled: false
        }
      },
      warnings,
      counts: {
        logbookMissing: warnings.logbookMissing.length,
        attendanceAbsent: warnings.attendanceAbsent.length,
        lowHours: warnings.lowHours.length,
        total: warnings.logbookMissing.length + warnings.attendanceAbsent.length + warnings.lowHours.length
      }
    });
  })
);

router.post(
  "/operator-warnings/review",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Akses ditolak. Review warning dashboard hanya untuk operator." });
    }

    await ensureDashboardWarningReviewTable();

    const {
      studentId,
      recipientUserId,
      type,
      referenceDate,
      referencePeriod,
      reviewNote
    } = req.body || {};

    const normalizedType = normalizeDashboardReminderType(type);
    if (!normalizedType) {
      return res.status(400).json({ message: "type warning tidak valid." });
    }

    const resolvedStudentId = await resolveDashboardReminderStudentId({ studentId, recipientUserId });
    if (!resolvedStudentId) {
      return res.status(404).json({ message: "Mahasiswa warning tidak ditemukan." });
    }

    const identity = buildReminderIdentity({
      type: normalizedType,
      referenceDate,
      referencePeriod
    });

    const existingReview = await findExistingDashboardWarningReview({
      studentId: resolvedStudentId,
      type: normalizedType,
      referenceDate: identity.referenceDate,
      referencePeriod: identity.referencePeriod
    });

    if (existingReview) {
      return res.status(200).json({
        message: "Warning dashboard untuk periode ini sudah pernah ditandai ditinjau.",
        duplicate: true,
        review: {
          type: normalizedType,
          referenceDate: identity.referenceDate,
          referencePeriod: identity.referencePeriod,
          reviewedAt: existingReview.reviewed_at
        }
      });
    }

    const reviewerUserId = req.authUser?.id || String(req.headers["x-user-id"] || "").trim() || null;
    const reviewResult = await recordDashboardWarningReview({
      studentId: resolvedStudentId,
      type: normalizedType,
      referenceDate: identity.referenceDate,
      referencePeriod: identity.referencePeriod,
      reviewedBy: reviewerUserId,
      reviewNote
    });

    res.status(201).json({
      message: "Warning dashboard berhasil ditandai sudah ditinjau.",
      review: {
        id: reviewResult.id,
        studentId: resolvedStudentId,
        type: normalizedType,
        referenceDate: reviewResult.referenceDate,
        referencePeriod: reviewResult.referencePeriod
      }
    });
  })
);

router.get(
  "/student",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    const userId = role === "mahasiswa" ? req.authUser?.id : req.query.userId;
    if (!["mahasiswa", "operator"].includes(role)) {
      return res.status(403).json({ message: "Akses ditolak untuk role ini." });
    }

    if (!userId) {
      return res.status(400).json({ message: "userId wajib diisi." });
    }

    const studentResult = await query(
      "SELECT id, nim, TO_CHAR(created_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS active_start_date FROM students WHERE user_id = $1",
      [userId]
    );
    if (studentResult.rowCount === 0) {
      return res.status(404).json({ message: "Data mahasiswa tidak ditemukan." });
    }

    const studentId = studentResult.rows[0].id;

    await query(`
      ALTER TABLE leave_requests
      ADD COLUMN IF NOT EXISTS jenis_pengajuan TEXT NOT NULL DEFAULT 'cuti',
      ADD COLUMN IF NOT EXISTS counts_against_leave_quota BOOLEAN NOT NULL DEFAULT TRUE
    `);

    const [researchRows, milestonesRows, logbookRows, leaveRows, attendanceRows, todayAttendanceRows, letterRows, certRows, settings] = await Promise.all([
      query(
        `
        SELECT rp.id, rp.short_title, rp.status, rp.progress, rp.period_text, rm.peran
        FROM research_projects rp
        JOIN research_memberships rm ON rm.project_id = rp.id
        WHERE rm.user_id = $1
        ORDER BY rp.id
        `,
        [userId]
      ),
      query(
        `
        SELECT rm.project_id, m.label, m.done, m.sort_order
        FROM research_memberships rm
        JOIN research_milestones m ON m.project_id = rm.project_id
        WHERE rm.user_id = $1
        ORDER BY rm.project_id ASC, m.sort_order ASC, m.id ASC
        `,
        [userId]
      ),
      query("SELECT id, title, date, description, output, project_id FROM logbook_entries WHERE student_id = $1 ORDER BY date DESC LIMIT 5", [studentId]),
      query("SELECT id, status, durasi, periode_start, periode_end, jenis_pengajuan, counts_against_leave_quota FROM leave_requests WHERE student_id = $1 ORDER BY tanggal_pengajuan DESC", [studentId]),
      query(
        `
        SELECT status
        FROM attendance_records
        WHERE student_id = $1
          AND date_trunc('month', attendance_date) = date_trunc('month', CURRENT_DATE)
          AND attendance_date >= $2::date
        `,
        [studentId, studentResult.rows[0].active_start_date]
      ),
      query(
        `
        SELECT check_in_at, check_out_at, status
        FROM attendance_records
        WHERE student_id = $1 AND attendance_date = CURRENT_DATE
        LIMIT 1
        `,
        [studentId]
      ),
      query(
        `
        SELECT id, jenis, status, tanggal, estimasi
        FROM letter_requests
        WHERE student_id = $1
        ORDER BY tanggal DESC, id DESC
        LIMIT 5
        `,
        [studentId]
      ),
      query(
        `
        SELECT id, status, issue_date, certificate_number, file_url, project_id
        FROM certificate_requests
        WHERE student_id = $1
        ORDER BY updated_at DESC, id DESC
        `,
        [studentId]
      ),
      getSettingsAsync()
    ]);

    const projects = researchRows.rows;
    const milestonesByProject = milestonesRows.rows.reduce((acc, item) => {
      if (!acc[item.project_id]) acc[item.project_id] = [];
      acc[item.project_id].push({ label: item.label, done: Boolean(item.done) });
      return acc;
    }, {});
    const attendanceHadir = attendanceRows.rows.filter((item) => item.status === "Hadir").length;
    const attendanceTotal = attendanceRows.rows.length;
    const approvedLeaveCount = leaveRows.rows
      .filter((item) => item.status === "Disetujui" && item.jenis_pengajuan === "cuti" && item.counts_against_leave_quota !== false)
      .reduce((sum, item) => sum + Number(item.durasi || 0), 0);
    const totalCuti = Number(settings?.cuti?.maxSemesterDays || 3);
    const sisaCuti = Math.max(0, totalCuti - approvedLeaveCount);
    const dokSiapUnduh = letterRows.rows.filter((item) => item.status === "Siap Unduh").length;
    const todayAttendance = todayAttendanceRows.rows[0] || null;
    const certTerbitCount = certRows.rows.filter((item) => item.status === "Terbit").length;

    res.json({
      header: {
        activeResearchCount: projects.filter((item) => item.status === "Aktif").length,
        nim: studentResult.rows[0].nim
      },
      stats: {
        attendanceHadir,
        attendanceTotal,
        logbookEntries: logbookRows.rowCount,
        logbookTarget: 40,
        tasksDone: projects.reduce((sum, item) => sum + Math.round((Number(item.progress) || 0) / 10), 0),
        tasksTotal: Math.max(projects.length * 10, 0),
        sisaCuti,
        totalCuti,
        dokSiapUnduh
      },
      projects: projects.map((item) => ({
        id: item.id,
        shortTitle: item.short_title,
        status: item.status,
        progress: Number(item.progress) || 0,
        tugasSelesai: Math.max(0, Math.round((item.progress || 0) / 10)),
        tugasTotal: 10,
        milestones: milestonesByProject[item.id] || [],
        peranSaya: item.peran || "Anggota",
        peranColor: /ketua/i.test(item.peran || "") ? "bg-indigo-100 text-indigo-700" : "bg-slate-100 text-slate-600",
        period: item.period_text || "-",
        progressColor: "bg-indigo-500"
      })),
      sprintTasks: [],
      logbookRecent: logbookRows.rows.map((item) => ({
        date: new Date(item.date).toLocaleDateString("id-ID"),
        riset: projects.find((p) => p.id === item.project_id)?.short_title || "Riset",
        desc: item.description || item.title,
        output: item.output || "-"
      })),
      leaveRecent: leaveRows.rows.slice(0, 3).map((item) => ({
        id: item.id,
        period: `${new Date(item.periode_start).toLocaleDateString("id-ID")} - ${new Date(item.periode_end).toLocaleDateString("id-ID")}`,
        durasi: `${item.durasi} hari`,
        status: item.status
      })),
      draftRecent: [],
      letterRecent: letterRows.rows.map((item) => ({
        id: item.id,
        jenis: item.jenis,
        status: item.status,
        tanggal: item.tanggal,
        estimasi: item.estimasi || null
      })),
      certificates: certRows.rows,
      certificateTerbitCount: certTerbitCount,
      attendanceToday: {
        status: todayAttendance?.status || "Belum Check-in",
        checkInAt: todayAttendance?.check_in_at || null,
        checkOutAt: todayAttendance?.check_out_at || null
      }
    });
  })
);

router.get(
  "/lecturer",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    const userId = role === "dosen" ? req.authUser?.id : req.query.userId;
    if (!["dosen", "operator"].includes(role)) {
      return res.status(403).json({ message: "Akses ditolak untuk role ini." });
    }

    if (!userId) {
      return res.status(400).json({ message: "userId wajib diisi." });
    }

    const [researchRows, pendingLogRows, leaveRows, boardRows, deadlineRows, mahasiswaRows] = await Promise.all([
      query(
        `
        SELECT rp.id, rp.title, rp.short_title, rp.status, rp.progress, rp.period_text
        FROM research_projects rp
        LEFT JOIN lecturers l ON l.id = rp.supervisor_lecturer_id
        WHERE l.user_id = $1
        ORDER BY rp.id
        `,
        [userId]
      ),
      query(
        `
        SELECT le.id, le.title, le.date, su.name AS student_name, rp.short_title AS project_name
        FROM logbook_entries le
        JOIN students s ON s.id = le.student_id
        JOIN users su ON su.id = s.user_id
        JOIN research_projects rp ON rp.id = le.project_id
        LEFT JOIN lecturers l ON l.id = rp.supervisor_lecturer_id
        WHERE l.user_id = $1
        ORDER BY le.date DESC
        LIMIT 5
        `,
        [userId]
      ),
      query(
        `
        SELECT lr.id, lr.status, lr.alasan, lr.periode_start, lr.periode_end, lr.durasi, su.name AS student_name
        FROM leave_requests lr
        JOIN students s ON s.id = lr.student_id
        JOIN users su ON su.id = s.user_id
        JOIN research_projects rp ON rp.id = lr.project_id
        LEFT JOIN lecturers l ON l.id = rp.supervisor_lecturer_id
        WHERE lr.status = 'Menunggu'
          AND l.user_id = $1
        ORDER BY lr.tanggal_pengajuan DESC
        LIMIT 5
        `,
        [userId]
      ),
      query(
        `
        SELECT le.project_id,
               COUNT(*)::int FILTER (WHERE COALESCE(lc.comment_count, 0) = 0) AS review,
               COUNT(*)::int FILTER (WHERE COALESCE(lc.comment_count, 0) > 0) AS done
        FROM logbook_entries le
        JOIN research_projects rp ON rp.id = le.project_id
        LEFT JOIN lecturers l ON l.id = rp.supervisor_lecturer_id
        LEFT JOIN (
          SELECT logbook_entry_id, COUNT(*)::int AS comment_count
          FROM logbook_comments
          GROUP BY logbook_entry_id
        ) lc ON lc.logbook_entry_id = le.id
        WHERE l.user_id = $1
        GROUP BY le.project_id
        `,
        [userId]
      ),
      query(
        `
        SELECT rp.short_title AS riset, m.label AS task, m.target_date AS deadline
        FROM research_milestones m
        JOIN research_projects rp ON rp.id = m.project_id
        LEFT JOIN lecturers l ON l.id = rp.supervisor_lecturer_id
        WHERE l.user_id = $1
          AND m.done = FALSE
          AND m.target_date IS NOT NULL
        ORDER BY m.target_date ASC
        LIMIT 8
        `,
        [userId]
      ),
      query(
        `
        SELECT COUNT(DISTINCT rm.user_id)::int AS total
        FROM research_memberships rm
        JOIN users u ON u.id = rm.user_id
        JOIN research_projects rp ON rp.id = rm.project_id
        LEFT JOIN lecturers l ON l.id = rp.supervisor_lecturer_id
        WHERE l.user_id = $1
          AND u.role = 'mahasiswa'
        `,
        [userId]
      )
    ]);

    const myResearch = researchRows.rows;

    res.json({
      stats: {
        risetDipimpin: myResearch.length,
        mahasiswaAktif: mahasiswaRows.rows[0]?.total || 0,
        pendingLogbook: pendingLogRows.rowCount,
        cutiMenunggu: leaveRows.rowCount
      },
      myResearch,
      boardSummary: myResearch.map((item) => ({
        id: item.id,
        todo: 0,
        doing: 0,
        review: boardRows.rows.find((row) => row.project_id === item.id)?.review || 0,
        done: boardRows.rows.find((row) => row.project_id === item.id)?.done || 0
      })),
      pendingLogs: pendingLogRows.rows,
      pendingLeaves: leaveRows.rows,
      deadlines: deadlineRows.rows.map((item) => ({
        riset: item.riset,
        task: item.task,
        deadline: item.deadline,
        overdue: new Date(item.deadline) < new Date()
      }))
    });
  })
);

module.exports = router;
