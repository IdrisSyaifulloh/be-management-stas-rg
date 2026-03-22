const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { getSettingsAsync } = require("../../config/systemSettingsStore");
const { extractRole } = require("../../utils/roleGuard");

const router = express.Router();

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

    const studentResult = await query("SELECT id, nim FROM students WHERE user_id = $1", [userId]);
    if (studentResult.rowCount === 0) {
      return res.status(404).json({ message: "Data mahasiswa tidak ditemukan." });
    }

    const studentId = studentResult.rows[0].id;

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
      query("SELECT id, status, durasi, periode_start, periode_end FROM leave_requests WHERE student_id = $1 ORDER BY tanggal_pengajuan DESC", [studentId]),
      query(
        `
        SELECT status
        FROM attendance_records
        WHERE student_id = $1
          AND date_trunc('month', attendance_date) = date_trunc('month', CURRENT_DATE)
        `,
        [studentId]
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
    const approvedLeaveCount = leaveRows.rows.filter((item) => item.status === "Disetujui").length;
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
