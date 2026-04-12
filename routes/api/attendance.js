const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { getSettingsAsync } = require("../../config/systemSettingsStore");
const { extractRole } = require("../../utils/roleGuard");
const { resolveStudentId } = require("../../utils/studentResolver");
const {
  buildAttendanceHistory,
  getJakartaDateIso,
  getMonthBounds
} = require("../../utils/attendanceHistory");

const router = express.Router();

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function haversineDistanceMeters(lat1, lng1, lat2, lng2) {
  const earthRadius = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const partA =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const partC = 2 * Math.atan2(Math.sqrt(partA), Math.sqrt(1 - partA));
  return earthRadius * partC;
}

router.post(
  "/check-in",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (!["mahasiswa", "operator"].includes(role)) {
      return res.status(403).json({ message: "Role tidak diizinkan melakukan check-in." });
    }

    const { studentId, latitude, longitude, accuracy } = req.body || {};
    const studentIdInput = role === "mahasiswa" ? (req.authUser?.id || studentId) : studentId;
    if (!studentIdInput || latitude == null || longitude == null) {
      return res.status(400).json({ message: "studentId, latitude, dan longitude wajib diisi." });
    }

    const resolvedStudentId = await resolveStudentId(studentIdInput);
    if (!resolvedStudentId) {
      return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    }

    const settings = await getSettingsAsync();
    const gps = settings.gps || {};
    const distanceMeters = haversineDistanceMeters(Number(latitude), Number(longitude), Number(gps.latitude), Number(gps.longitude));

    if (distanceMeters > Number(gps.radius || 0)) {
      return res.status(400).json({
        message: "Lokasi di luar radius absensi.",
        distanceMeters: Math.round(distanceMeters),
        allowedRadiusMeters: Number(gps.radius || 0)
      });
    }

    const todayRecord = await query(
      `
      SELECT id, check_in_at, check_out_at
      FROM attendance_records
      WHERE student_id = $1 AND attendance_date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date
      LIMIT 1
      `,
      [resolvedStudentId]
    );

    if (todayRecord.rowCount > 0 && todayRecord.rows[0].check_out_at) {
      return res.status(409).json({ message: "Absensi hari ini sudah selesai (sudah check-out)." });
    }

    if (todayRecord.rowCount > 0 && todayRecord.rows[0].check_in_at) {
      return res.status(409).json({ message: "Check-in hari ini sudah tercatat." });
    }

    const recordId = `ATD-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

    if (todayRecord.rowCount > 0) {
      await query(
        `
        UPDATE attendance_records
        SET status = 'Hadir',
            check_in_at = NOW(),
          check_out_at = NULL,
            check_in_lat = $2,
            check_in_lng = $3,
          check_out_lat = NULL,
          check_out_lng = NULL,
            accuracy_meters = $4,
            distance_meters = $5,
            within_radius = TRUE,
            updated_at = NOW()
        WHERE id = $1
        `,
        [todayRecord.rows[0].id, Number(latitude), Number(longitude), accuracy == null ? null : Number(accuracy), distanceMeters]
      );
    } else {
      await query(
        `
        INSERT INTO attendance_records (
          id, student_id, attendance_date, status, check_in_at,
          check_in_lat, check_in_lng, accuracy_meters, distance_meters, within_radius
        ) VALUES ($1, $2, (NOW() AT TIME ZONE 'Asia/Jakarta')::date, 'Hadir', NOW(), $3, $4, $5, $6, TRUE)
        `,
        [recordId, resolvedStudentId, Number(latitude), Number(longitude), accuracy == null ? null : Number(accuracy), distanceMeters]
      );
    }

    res.status(201).json({
      message: "Check-in berhasil.",
      distanceMeters: Math.round(distanceMeters)
    });
  })
);

router.post(
  "/check-out",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (!["mahasiswa", "operator"].includes(role)) {
      return res.status(403).json({ message: "Role tidak diizinkan melakukan check-out." });
    }

    const { studentId, latitude, longitude } = req.body || {};
    const studentIdInput = role === "mahasiswa" ? (req.authUser?.id || studentId) : studentId;
    if (!studentIdInput || latitude == null || longitude == null) {
      return res.status(400).json({ message: "studentId, latitude, dan longitude wajib diisi." });
    }

    const resolvedStudentId = await resolveStudentId(studentIdInput);
    if (!resolvedStudentId) {
      return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    }

    const todayRecord = await query(
      `
      SELECT id, check_in_at, check_out_at
      FROM attendance_records
      WHERE student_id = $1 AND attendance_date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date
      LIMIT 1
      `,
      [resolvedStudentId]
    );

    if (todayRecord.rowCount === 0 || !todayRecord.rows[0].check_in_at) {
      return res.status(404).json({ message: "Belum ada check-in hari ini." });
    }

    if (todayRecord.rows[0].check_out_at) {
      return res.status(409).json({ message: "Check-out hari ini sudah tercatat." });
    }

    await query(
      `
      UPDATE attendance_records
      SET check_out_at = NOW(),
          check_out_lat = $2,
          check_out_lng = $3,
          updated_at = NOW()
      WHERE id = $1
      `,
      [todayRecord.rows[0].id, Number(latitude), Number(longitude)]
    );

    res.json({ message: "Check-out berhasil." });
  })
);

router.get(
  "/monitor/today",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Akses monitor absensi hanya untuk operator." });
    }

    const studentsResult = await query(
      `
      SELECT s.id
      FROM students s
      JOIN users u ON u.id = s.user_id
      WHERE u.is_active = TRUE
      `
    );

    const attendanceResult = await query(
      `
      SELECT student_id, status
      FROM attendance_records
      WHERE attendance_date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date
      `
    );

    const leavesResult = await query(
      `
      SELECT DISTINCT student_id
      FROM leave_requests
      WHERE status = 'Disetujui'
        AND (NOW() AT TIME ZONE 'Asia/Jakarta')::date BETWEEN periode_start AND periode_end
      `
    );

    const allStudentIds = studentsResult.rows.map((row) => row.id);
    const leaveSet = new Set(leavesResult.rows.map((row) => row.student_id));
    const attendanceMap = new Map(attendanceResult.rows.map((row) => [row.student_id, row.status]));

    const presentIds = [];
    const leaveIds = [];
    const absentIds = [];

    allStudentIds.forEach((studentId) => {
      const status = attendanceMap.get(studentId);
      if (status === "Hadir") {
        presentIds.push(studentId);
        return;
      }
      if (status === "Cuti" || leaveSet.has(studentId)) {
        leaveIds.push(studentId);
        return;
      }
      absentIds.push(studentId);
    });

    res.json({
      date: getJakartaDateIso(),
      presentIds,
      leaveIds,
      absentIds
    });
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    const studentId = role === "mahasiswa" ? (req.authUser?.id || req.query.studentId) : req.query.studentId;
    const { month } = req.query;
    if (!studentId) {
      return res.status(400).json({ message: "studentId wajib diisi." });
    }

    const resolvedStudentId = await resolveStudentId(String(studentId));
    if (!resolvedStudentId) {
      return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    }

    const monthValue = String(month || getJakartaDateIso().slice(0, 7));
    const { startDate, endDate } = getMonthBounds(`${monthValue}-01`);

    const attendanceRows = await query(
      `
      SELECT TO_CHAR(attendance_date, 'YYYY-MM-DD') AS attendance_date_text,
             check_in_at,
             check_out_at
      FROM attendance_records
      WHERE student_id = $1
        AND TO_CHAR(attendance_date, 'YYYY-MM') = $2
      ORDER BY attendance_date DESC
      `,
      [resolvedStudentId, monthValue]
    );

    const leaves = await query(
      `
      SELECT periode_start, periode_end
      FROM leave_requests
      WHERE student_id = $1
        AND status = 'Disetujui'
        AND TO_CHAR(periode_start, 'YYYY-MM') <= $2
        AND TO_CHAR(periode_end, 'YYYY-MM') >= $2
      `,
      [resolvedStudentId, monthValue]
    );

    const { attendanceMap, leaveSet, history, summary } = buildAttendanceHistory({
      startDate,
      endDate,
      attendanceRows: attendanceRows.rows,
      leaveRows: leaves.rows
    });

    const todayIso = getJakartaDateIso();
    const todayAttendance = attendanceMap.get(todayIso);
    const todayStatus = leaveSet.has(todayIso)
      ? "Cuti"
      : todayAttendance?.check_out_at
        ? "Selesai"
        : todayAttendance?.check_in_at
          ? "Berlangsung"
        : "Belum Check-in";

    const settings = await getSettingsAsync();
    const gps = settings.gps || {};

    res.json({
      month: monthValue,
      chartData: [
        { name: "Hadir", value: summary.hadir, color: "#0AB600" },
        { name: "Tidak Hadir", value: summary.tidakHadir, color: "#EF4444" },
        { name: "Cuti", value: summary.cuti, color: "#F59E0B" },
        { name: "Libur", value: summary.libur, color: "#94A3B8" }
      ],
      today: {
        checkIn: todayAttendance?.check_in_at
          ? new Date(todayAttendance.check_in_at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false })
          : "--:--",
        checkOut: todayAttendance?.check_out_at
          ? new Date(todayAttendance.check_out_at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false })
          : "--:--",
        status: todayStatus
      },
      gps: {
        latitude: Number(gps.latitude),
        longitude: Number(gps.longitude),
        radius: Number(gps.radius)
      },
      history: history
        .map((item) => ({
          date: item.dateLabel,
          in: item.in,
          out: item.out,
          duration: item.duration,
          status: item.status,
          statusColor: item.statusColor
        }))
        .reverse()
        .slice(0, 31)
    });
  })
);

module.exports = router;
