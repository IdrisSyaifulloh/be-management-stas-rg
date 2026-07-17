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
const {
  createAttendanceAbsentLocks,
  deactivateAttendanceAbsentLocksForDate
} = require("../../utils/studentAccessLocks");
const { requireSafeId } = require("../../utils/securityValidation");
const { getJakartaWeekBounds } = require("../../utils/jakartaWeek");
const { findNonWorkingDayForDate } = require("../../utils/holidays");
const { ensureStudentDocumentsTable, fetchStudentDocuments } = require("../../utils/studentDocuments");
const { ensurePicketTables } = require("../../utils/picketService");

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

function addIsoDays(isoDate, days) {
  const [year, month, day] = String(isoDate || "").split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function getSundayBasedJakartaWeekBounds(date = new Date()) {
  const { date: today } = getJakartaNowParts(date);
  const [year, month, day] = today.split("-").map(Number);
  const dayIndex = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const weekStart = addIsoDays(today, -dayIndex);
  const weekEnd = addIsoDays(weekStart, 6);

  return {
    today,
    weekStart,
    weekEnd,
    queryEnd: today < weekEnd ? today : weekEnd
  };
}

function normalizeSearchValue(value) {
  return String(value || "").trim().toLowerCase();
}

function itemMatchesSearch(item, searchValue) {
  if (!searchValue) return true;

  return [
    item.student_name,
    item.studentName,
    item.student_initials,
    item.studentInitials,
    item.nim,
    item.attendance_status,
    item.attendanceStatus,
    item.reference_date,
    item.referenceDate
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(searchValue));
}

router.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);

    if (role !== "operator") {
      return res.status(403).json({
        message: "Akses ditolak. Ringkasan dashboard hanya untuk operator."
      });
    }

    const [
      students,
      alumni,
      lecturers,
      research,
      leavePending,
      lettersPending,
      graduationPending,
      documents,
      latestLogbooks
    ] = await Promise.all([
      query("SELECT COUNT(*)::int AS total FROM students WHERE status = 'Aktif'"),
      query("SELECT COUNT(*)::int AS total FROM students WHERE status = 'Alumni'"),
      query("SELECT COUNT(*)::int AS total FROM lecturers"),
      query("SELECT COUNT(*)::int AS total FROM research_projects WHERE status = 'Aktif'"),
      query("SELECT COUNT(*)::int AS total FROM leave_requests WHERE status = 'Menunggu'"),
      query("SELECT COUNT(*)::int AS total FROM letter_requests WHERE status = 'Menunggu'"),
      query("SELECT COUNT(*)::int AS total FROM graduation_submissions WHERE status IN ('Dikirim', 'Revisi')"),
      query("SELECT COUNT(*)::int AS total FROM dc_official_documents"),
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
      totalAlumni: alumni.rows[0].total,
      totalDosen: lecturers.rows[0].total,
      totalRisetAktif: research.rows[0].total,
      cutiMenunggu: leavePending.rows[0].total,
      suratMenunggu: lettersPending.rows[0].total,
      kelulusanMenunggu: graduationPending.rows[0].total,
      totalDokumen: documents.rows[0].total,
      logbookTerbaru: latestLogbooks.rows
    });
  })
);

router.get(
  "/picket-weekly-misses",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);

    if (!["operator", "admin"].includes(role)) {
      return res.status(403).json({
        message: "Akses ditolak. Dashboard pelanggaran piket hanya untuk operator/admin."
      });
    }

    await ensurePicketTables();

    const { weekStart, weekEnd, queryEnd } = getSundayBasedJakartaWeekBounds();

    const result = await query(
      `
      SELECT
        psch.student_id,
        u.name AS student_name,
        u.initials AS student_initials,
        s.nim,
        COUNT(*)::int AS missed_count,
        ARRAY_AGG(TO_CHAR(psch.schedule_date, 'YYYY-MM-DD') ORDER BY psch.schedule_date ASC, psch.id ASC) AS missed_dates,
        ARRAY_AGG(COALESCE(pt.name, 'Piket') ORDER BY psch.schedule_date ASC, psch.id ASC) AS task_names,
        TO_CHAR(MAX(psch.schedule_date), 'YYYY-MM-DD') AS last_missed_date
      FROM picket_schedules psch
      JOIN students s ON s.id = psch.student_id
      JOIN users u ON u.id = s.user_id
      LEFT JOIN picket_tasks pt ON pt.id = psch.task_id
      WHERE psch.schedule_date BETWEEN $1::date AND $2::date
        AND NOT EXISTS (
          SELECT 1
          FROM picket_holidays ph
          WHERE ph.holiday_date = psch.schedule_date
        )
        AND NOT EXISTS (
          SELECT 1
          FROM picket_leave_requests plr
          WHERE plr.schedule_id = psch.id
            AND plr.student_id = psch.student_id
            AND plr.status = 'Disetujui'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM picket_submissions psub
          WHERE psub.schedule_id = psch.id
            AND psub.student_id = psch.student_id
            AND psub.status <> 'Bermasalah'
        )
      GROUP BY psch.student_id, u.name, u.initials, s.nim
      ORDER BY missed_count DESC, MAX(psch.schedule_date) DESC, u.name ASC
      `,
      [weekStart, queryEnd]
    );

    const items = result.rows.map((row) => ({
      studentId: row.student_id,
      studentName: row.student_name,
      studentInitials: row.student_initials,
      nim: row.nim,
      missedCount: Number(row.missed_count) || 0,
      missedDates: row.missed_dates || [],
      taskNames: row.task_names || [],
      lastMissedDate: row.last_missed_date,
      status: "Belum Submit"
    }));

    return res.json({
      weekStart,
      weekEnd,
      resetDay: "Minggu",
      items
    });
  })
);

router.get(
  "/operator-warnings",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);

    if (role !== "operator") {
      return res.status(403).json({
        message: "Akses ditolak. Warning dashboard operator hanya untuk operator."
      });
    }

    await ensureDashboardReminderTable();
    await ensureDashboardWarningReviewTable();

    const nowParts = getJakartaNowParts();
    const settings = await getSettingsAsync();
    const todayHoliday = findNonWorkingDayForDate(settings, nowParts.date);
    const attendanceSectionActive = isAfterAttendanceCutoff(nowParts.time) && !todayHoliday;
    const attendanceAbsentSearch = normalizeSearchValue(
      req.query.attendanceAbsentSearch || req.query.absentSearch || req.query.tidakHadirSearch
    );

    const calendarResult = await query(
      `
      SELECT to_char($1::date, 'IYYY-"W"IW') AS week_key
      `,
      [nowParts.date]
    );

    const today = nowParts.date;
    const weekKey = calendarResult.rows[0]?.week_key;

    if (todayHoliday) {
      await deactivateAttendanceAbsentLocksForDate({ date: today });
    }

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
        LIMIT 500
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
              'Belum Absen' AS attendance_status,
              $1::date AS reference_date
            FROM students s
            JOIN users u ON u.id = s.user_id
            WHERE s.status = 'Aktif'
              AND NOT EXISTS (
                SELECT 1
                FROM attendance_records ar
                WHERE ar.student_id = s.id
                  AND ar.attendance_date = $1::date
              )
              AND NOT EXISTS (
                SELECT 1
                FROM leave_requests lr
                WHERE lr.student_id = s.id
                  AND lr.status = 'Disetujui'
                  AND $1::date BETWEEN lr.periode_start AND lr.periode_end
              )
              AND NOT EXISTS (
                SELECT 1
                FROM dashboard_warning_reviews dwr
                WHERE dwr.student_id = s.id
                  AND dwr.type = 'attendance_absent'
                  AND dwr.reference_date = $1::date
              )
            ORDER BY u.name ASC
            LIMIT 500
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
          AND s.tipe = 'Riset'
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
        LIMIT 500
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

    const attendanceAbsentWarnings = attendanceSectionActive
      ? attendanceAbsentRows.rows.map((row) => mapWarningItem(row, "attendance_absent"))
      : [];

    const warnings = {
      logbookMissing: logbookMissingRows.rows.map((row) => mapWarningItem(row, "logbook_missing")),
      attendanceAbsent: attendanceAbsentWarnings.filter((item) => itemMatchesSearch(item, attendanceAbsentSearch)),
      lowHours: lowHoursRows.rows.map((row) => mapWarningItem(row, "low_hours"))
    };

    if (attendanceSectionActive && attendanceAbsentWarnings.length > 0) {
      await createAttendanceAbsentLocks({
        studentIds: attendanceAbsentWarnings.map((item) => item.studentId),
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
          isHoliday: Boolean(todayHoliday),
          holidayToday: todayHoliday,
          notificationEnabled: false,
          search: attendanceAbsentSearch
        }
      },
      warnings,
      counts: {
        logbookMissing: warnings.logbookMissing.length,
        attendanceAbsent: warnings.attendanceAbsent.length,
        lowHours: warnings.lowHours.length,
        total:
          warnings.logbookMissing.length +
          warnings.attendanceAbsent.length +
          warnings.lowHours.length
      }
    });
  })
);

router.post(
  "/operator-warnings/review",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);

    if (role !== "operator") {
      return res.status(403).json({
        message: "Akses ditolak. Review warning dashboard hanya untuk operator."
      });
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
      return res.status(400).json({
        message: "type warning tidak valid."
      });
    }

    const resolvedStudentId = await resolveDashboardReminderStudentId({
      studentId,
      recipientUserId
    });

    if (!resolvedStudentId) {
      return res.status(404).json({
        message: "Mahasiswa warning tidak ditemukan."
      });
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

    const reviewerUserId = req.authUser?.id || null;

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
      return res.status(403).json({
        message: "Akses ditolak untuk role ini."
      });
    }

    if (!userId) {
      return res.status(400).json({
        message: "userId wajib diisi."
      });
    }

    requireSafeId(userId, "userId");

    await query(`
      ALTER TABLE students
      ADD COLUMN IF NOT EXISTS wfh_quota INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS jam_minggu_ini NUMERIC(5,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS jam_minggu_target NUMERIC(5,2) NOT NULL DEFAULT 6
    `);

    await ensureStudentDocumentsTable();

    await query(`
      ALTER TABLE leave_requests
      ADD COLUMN IF NOT EXISTS jenis_pengajuan TEXT NOT NULL DEFAULT 'cuti',
      ADD COLUMN IF NOT EXISTS counts_against_leave_quota BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS counts_against_wfh_quota BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await query(`
      ALTER TABLE leave_requests
      DROP CONSTRAINT IF EXISTS leave_requests_jenis_pengajuan_check,
      ADD CONSTRAINT leave_requests_jenis_pengajuan_check
        CHECK (jenis_pengajuan IN ('cuti', 'izin', 'sakit', 'wfh'))
    `);

    const studentResult = await query(
      `
      SELECT 
        id,
        nim,
        pembimbing,
        status,
        tipe,
        COALESCE(wfh_quota, 0)::int AS wfh_quota,
        COALESCE(jam_minggu_ini, 0)::numeric AS jam_minggu_ini,
        COALESCE(jam_minggu_target, 0)::numeric AS jam_minggu_target,
        TO_CHAR(created_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS active_start_date
      FROM students
      WHERE user_id = $1
      LIMIT 1
      `,
      [userId]
    );

    if (studentResult.rowCount === 0) {
      return res.status(404).json({
        message: "Data mahasiswa tidak ditemukan."
      });
    }

    const studentRow = studentResult.rows[0];
    const studentId = studentRow.id;

    const [
      researchRows,
      milestonesRows,
      logbookRows,
      leaveRows,
      attendanceRows,
      todayAttendanceRows,
      letterRows,
      certRows,
      settings
    ] = await Promise.all([
      query(
        `
        SELECT rp.id, rp.short_title, rp.status, rp.progress, rp.period_text, rm.peran
        FROM research_projects rp
        JOIN research_memberships rm ON rm.project_id = rp.id
        WHERE rm.user_id = $1
          AND COALESCE(rm.status, 'Aktif') = 'Aktif'
          AND (rm.selesai IS NULL OR rm.selesai >= CURRENT_DATE)
        ORDER BY rp.id
        LIMIT 100
        `,
        [userId]
      ),
      query(
        `
        SELECT rm.project_id, m.label, m.done, m.sort_order
        FROM research_memberships rm
        JOIN research_milestones m ON m.project_id = rm.project_id
        WHERE rm.user_id = $1
          AND COALESCE(rm.status, 'Aktif') = 'Aktif'
          AND (rm.selesai IS NULL OR rm.selesai >= CURRENT_DATE)
        ORDER BY rm.project_id ASC, m.sort_order ASC, m.id ASC
        LIMIT 500
        `,
        [userId]
      ),
      query(
        `
        SELECT id, title, date, description, output, project_id
        FROM logbook_entries
        WHERE student_id = $1
        ORDER BY date DESC
        LIMIT 5
        `,
        [studentId]
      ),
      query(
        `
        SELECT id, status, durasi, periode_start, periode_end, jenis_pengajuan,
               counts_against_leave_quota, counts_against_wfh_quota
        FROM leave_requests
        WHERE student_id = $1
        ORDER BY tanggal_pengajuan DESC
        LIMIT 200
        `,
        [studentId]
      ),
      query(
        `
        SELECT status
        FROM attendance_records
        WHERE student_id = $1
          AND date_trunc('month', attendance_date) = date_trunc('month', CURRENT_DATE)
          AND attendance_date >= $2::date
        LIMIT 31
        `,
        [studentId, studentRow.active_start_date]
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
        LIMIT 100
        `,
        [studentId]
      ),
      getSettingsAsync()
    ]);

    const projects = researchRows.rows;

    const milestonesByProject = milestonesRows.rows.reduce((acc, item) => {
      if (!acc[item.project_id]) acc[item.project_id] = [];
      acc[item.project_id].push({
        label: item.label,
        done: Boolean(item.done)
      });
      return acc;
    }, {});

    const attendanceHadir = attendanceRows.rows.filter((item) => ["Hadir", "WFH"].includes(item.status)).length;
    const attendanceTotal = attendanceRows.rows.length;

    const approvedLeaveCount = leaveRows.rows
      .filter(
        (item) =>
          item.status === "Disetujui" &&
          item.jenis_pengajuan === "cuti" &&
          item.counts_against_leave_quota !== false
      )
      .reduce((sum, item) => sum + Number(item.durasi || 0), 0);

    const totalCuti = Number(settings?.cuti?.maxSemesterDays || 3);
    const sisaCuti = Math.max(0, totalCuti - approvedLeaveCount);

    const wfhQuota = Number(studentRow.wfh_quota || 0);
    const weekBounds = getJakartaWeekBounds(new Date());

    const wfhUsed = leaveRows.rows.filter(
      (item) =>
        item.status === "Disetujui" &&
        item.jenis_pengajuan === "wfh" &&
        item.counts_against_wfh_quota !== false &&
        new Date(item.periode_start) >= new Date(weekBounds.startDate) &&
        new Date(item.periode_start) <= new Date(weekBounds.endDate)
    ).length;

    const wfhRemaining = Math.max(0, wfhQuota - wfhUsed);

    const studentDocuments = await fetchStudentDocuments(studentId, studentRow.status);
    const uploadedStudentDocumentCount = studentDocuments.filter((item) => item.fileUrl || item.file_url).length;
    const dokSiapUnduh = letterRows.rows.filter((item) => item.status === "Siap Unduh").length + uploadedStudentDocumentCount;
    const todayAttendance = todayAttendanceRows.rows[0] || null;
    const certTerbitCount = certRows.rows.filter((item) => item.status === "Terbit").length;
    const weeklyAttendanceHoursResult = await query(
      `
      SELECT COALESCE(
        SUM(
          GREATEST(
            EXTRACT(EPOCH FROM (COALESCE(check_out_at, NOW()) - check_in_at)) / 3600.0,
            0
          )
        ),
        0
      )::numeric(10,2) AS total_hours
      FROM attendance_records
      WHERE student_id = $1
        AND status IN ('Hadir', 'WFH')
        AND check_in_at IS NOT NULL
        AND attendance_date >= date_trunc('week', (NOW() AT TIME ZONE 'Asia/Jakarta')::date)::date
        AND attendance_date <= (NOW() AT TIME ZONE 'Asia/Jakarta')::date
      `,
      [studentId]
    );
    const risetWeeklyHours = Number(weeklyAttendanceHoursResult.rows[0]?.total_hours || 0);
    const configuredRisetWeeklyTargetHours = Number(settings?.attendanceRules?.risetTargetWeeklyHours || 6);
    const configuredRisetWeeklyMinHours = Number(settings?.attendanceRules?.risetMinWeeklyHours || 4);
    const risetWeeklyTargetHours = configuredRisetWeeklyTargetHours > 0 ? configuredRisetWeeklyTargetHours : 6;
    const risetWeeklyMinHours = configuredRisetWeeklyMinHours > 0 ? configuredRisetWeeklyMinHours : 4;
    const risetWeeklyRemainingHours = Math.max(0, risetWeeklyTargetHours - risetWeeklyHours);
    const risetWeeklyPct = risetWeeklyTargetHours > 0
      ? Math.min(100, Math.round((risetWeeklyHours / risetWeeklyTargetHours) * 100))
      : 0;

    res.json({
      header: {
        activeResearchCount: projects.filter((item) => item.status === "Aktif").length,
        nim: studentRow.nim,
        tipe: studentRow.tipe,
        status: studentRow.status,
        studentStatus: studentRow.status
      },
      student: {
        id: studentId,
        status: studentRow.status,
        studentStatus: studentRow.status,
        tipe: studentRow.tipe,
        jam_minggu_ini: risetWeeklyHours,
        jamMingguIni: risetWeeklyHours,
        jam_minggu_target: risetWeeklyTargetHours,
        jamMingguTarget: risetWeeklyTargetHours,
        documents: studentDocuments,
        student_documents: studentDocuments
      },
      stats: {
        attendanceHadir,
        attendanceTotal,
        risetWeeklyHours,
        risetWeeklyTargetHours,
        risetWeeklyMinHours,
        risetWeeklyRemainingHours,
        risetWeeklyPct,
        risetWeeklyMeetsTarget: risetWeeklyTargetHours > 0 && risetWeeklyHours >= risetWeeklyTargetHours,
        risetWeeklyMeetsMin: risetWeeklyMinHours > 0 && risetWeeklyHours >= risetWeeklyMinHours,
        logbookEntries: logbookRows.rowCount,
        logbookTarget: 40,
        tasksDone: projects.reduce(
          (sum, item) => sum + Math.round((Number(item.progress) || 0) / 10),
          0
        ),
        tasksTotal: Math.max(projects.length * 10, 0),
        sisaCuti,
        totalCuti,
        totalWfh: wfhQuota,
        usedWfh: wfhUsed,
        sisaWfh: wfhRemaining,
        wfhQuota,
        wfhUsed,
        wfhRemaining,
        manualWfhQuota: wfhQuota,
        mentorWfhQuota: null,
        wfhQuotaSource: "student",
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
        peranColor: /ketua/i.test(item.peran || "")
          ? "bg-indigo-100 text-indigo-700"
          : "bg-slate-100 text-slate-600",
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
        jenis: item.jenis_pengajuan,
        jenis_pengajuan: item.jenis_pengajuan,
        period: `${new Date(item.periode_start).toLocaleDateString("id-ID")} - ${new Date(
          item.periode_end
        ).toLocaleDateString("id-ID")}`,
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
      return res.status(403).json({
        message: "Akses ditolak untuk role ini."
      });
    }

    if (!userId) {
      return res.status(400).json({
        message: "userId wajib diisi."
      });
    }

    requireSafeId(userId, "userId");

    const [
      researchRows,
      pendingLogRows,
      leaveRows,
      boardRows,
      deadlineRows,
      mahasiswaRows
    ] = await Promise.all([
      query(
        `
        SELECT rp.id, rp.title, rp.short_title, rp.status, rp.progress, rp.period_text
        FROM research_projects rp
        LEFT JOIN lecturers l ON l.id = rp.supervisor_lecturer_id
        WHERE l.user_id = $1
        ORDER BY rp.id
        LIMIT 100
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
