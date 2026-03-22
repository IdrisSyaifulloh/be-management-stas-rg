const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { getSettingsAsync } = require("../../config/systemSettingsStore");
const { extractRole } = require("../../utils/roleGuard");

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

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getJakartaDateIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

async function resolveStudentId(studentIdOrUserId) {
  const studentResult = await query("SELECT id FROM students WHERE id = $1 OR user_id = $1 LIMIT 1", [studentIdOrUserId]);
  if (studentResult.rowCount === 0) return null;
  return studentResult.rows[0].id;
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
    const [year, monthNum] = monthValue.split("-").map(Number);
    const daysInMonth = new Date(year, monthNum, 0).getDate();

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

    const leaveSet = new Set();
    for (const row of leaves.rows) {
      const start = new Date(row.periode_start);
      const end = new Date(row.periode_end);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        leaveSet.add(`${y}-${m}-${day}`);
      }
    }

    const attendanceMap = new Map(
      attendanceRows.rows.map((item) => [item.attendance_date_text, item])
    );
    const history = [];
    let hadir = 0;
    let cuti = 0;
    let tidakHadir = 0;
    let libur = 0;

    for (let day = 1; day <= daysInMonth; day += 1) {
      const date = new Date(year, monthNum - 1, day);
      const iso = formatLocalDate(date);
      const dayName = date.toLocaleDateString("id-ID", { weekday: "short" });
      const dateLabel = `${dayName}, ${String(day).padStart(2, "0")} ${date.toLocaleDateString("id-ID", { month: "short", year: "numeric" })}`;
      const isWeekend = date.getDay() === 0;

      let status = "Tidak Hadir";
      let statusColor = "red";

      if (isWeekend) {
        status = "Libur";
        statusColor = "gray";
        libur += 1;
      } else if (leaveSet.has(iso)) {
        status = "Cuti";
        statusColor = "amber";
        cuti += 1;
      } else if (attendanceMap.has(iso)) {
        status = "Hadir";
        statusColor = "green";
        hadir += 1;
      } else {
        tidakHadir += 1;
      }

      const attendanceItem = attendanceMap.get(iso);
      history.push({
        date: dateLabel,
        in: attendanceItem?.check_in_at
          ? new Date(attendanceItem.check_in_at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false })
          : "-",
        out: attendanceItem?.check_out_at
          ? new Date(attendanceItem.check_out_at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false })
          : "-",
        duration:
          attendanceItem?.check_in_at && attendanceItem?.check_out_at
            ? (() => {
                const diffMs = new Date(attendanceItem.check_out_at).getTime() - new Date(attendanceItem.check_in_at).getTime();
                const minutes = Math.max(0, Math.round(diffMs / 60000));
                const hours = Math.floor(minutes / 60);
                const remainingMinutes = minutes % 60;
                return `${hours}j ${remainingMinutes}m`;
              })()
            : "-",
        status,
        statusColor
      });
    }

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
        { name: "Hadir", value: hadir, color: "#0AB600" },
        { name: "Tidak Hadir", value: tidakHadir, color: "#EF4444" },
        { name: "Cuti", value: cuti, color: "#F59E0B" },
        { name: "Libur", value: libur, color: "#94A3B8" }
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
      history: history.reverse().slice(0, 31)
    });
  })
);

module.exports = router;
