const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { getSettingsAsync } = require("../../config/systemSettingsStore");
const {
  createNotification,
  hasNotificationDispatch,
  recordNotificationDispatch
} = require("../../utils/notificationService");
const { extractRole } = require("../../utils/roleGuard");
const { resolveStudentId } = require("../../utils/studentResolver");
const {
  buildAttendanceHistory,
  getJakartaDateIso,
  getMonthBounds,
  maxIsoDate,
  minIsoDate
} = require("../../utils/attendanceHistory");

const router = express.Router();
let ensureAttendanceColumnsPromise = null;

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

function calculateDurationHours(startDate, endDate = new Date()) {
  const start = new Date(startDate);
  return Math.max(0, (endDate.getTime() - start.getTime()) / (1000 * 60 * 60));
}

function roundHours(value) {
  return Math.round(value * 100) / 100;
}

function getAttendanceRules(settings) {
  return {
    magangMinCheckoutHours: Number(settings.attendanceRules?.magangMinCheckoutHours || 8),
    earlyCheckoutWarning: Boolean(settings.attendanceRules?.earlyCheckoutWarning ?? true)
  };
}

async function ensureAttendanceColumns() {
  if (!ensureAttendanceColumnsPromise) {
    ensureAttendanceColumnsPromise = query(`
      ALTER TABLE attendance_records
      ADD COLUMN IF NOT EXISTS check_out_accuracy_meters DOUBLE PRECISION
    `);
  }
  await ensureAttendanceColumnsPromise;
}

function parseGpsNumber(value) {
  if (value == null || value === "") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isValidLatitude(value) {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value) {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

function buildGpsPolicy(settings) {
  const gps = settings.gps || {};
  return {
    targetLatitude: Number(gps.latitude),
    targetLongitude: Number(gps.longitude),
    radiusMeters: Number(gps.radius || 80),
    maxAccuracyMeters: Number(gps.maxAccuracyMeters || 100),
    sampleCount: Number(gps.sampleCount || 2),
    timeoutMs: Number(gps.timeoutMs || 6000)
  };
}

function buildGpsValidationError({
  message,
  reason,
  accuracyMeters = null,
  maxAccuracyMeters = null,
  distanceMeters = null,
  allowedRadiusMeters = null
}) {
  return {
    message,
    reason,
    accuracyMeters,
    maxAccuracyMeters,
    distanceMeters,
    allowedRadiusMeters
  };
}

async function notifyOperatorsAboutEarlyCheckout({ attendanceRecordId, student, durationHours, requiredHours }) {
  const operators = await query(
    `
    SELECT id
    FROM users
    WHERE role = 'operator'
      AND is_active = TRUE
    `
  );

  const eventId = "early_checkout_magang";
  const referenceKey = `${attendanceRecordId}:${student.id}`;
  const title = `Checkout Magang Kurang dari ${requiredHours} Jam`;
  const body = `${student.name || "Mahasiswa"} (${student.nim || "-"}) checkout setelah ${durationHours} jam, di bawah batas ${requiredHours} jam.`;
  let notifiedCount = 0;

  for (const operator of operators.rows) {
    const alreadySent = await hasNotificationDispatch({
      eventId,
      recipientUserId: operator.id,
      referenceKey
    });

    if (alreadySent) continue;

    const notification = await createNotification({
      recipientUserId: operator.id,
      type: "pengumuman",
      title,
      body,
      eventId
    });

    if (notification.sent && notification.id) {
      notifiedCount += 1;
      await recordNotificationDispatch({
        eventId,
        recipientUserId: operator.id,
        referenceKey,
        notificationId: notification.id,
        payload: {
          attendanceRecordId,
          studentId: student.id,
          durationHours,
          requiredHours
        }
      });
    }
  }

  return notifiedCount;
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
    const userLatitude = parseGpsNumber(latitude);
    const userLongitude = parseGpsNumber(longitude);
    const accuracyMetersValue = accuracy == null ? null : parseGpsNumber(accuracy);

    if (
      !studentIdInput ||
      !isValidLatitude(userLatitude) ||
      !isValidLongitude(userLongitude) ||
      (accuracy != null && (!Number.isFinite(accuracyMetersValue) || accuracyMetersValue < 0))
    ) {
      return res.status(400).json(buildGpsValidationError({
        message: "Payload GPS tidak valid. studentId, latitude, dan longitude wajib valid.",
        reason: "INVALID_GPS_PAYLOAD",
        accuracyMeters: accuracyMetersValue == null ? null : Math.round(accuracyMetersValue)
      }));
    }

    const resolvedStudentId = await resolveStudentId(studentIdInput);
    if (!resolvedStudentId) {
      return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    }

    const settings = await getSettingsAsync();
    const gpsPolicy = buildGpsPolicy(settings);
    const refLat = gpsPolicy.targetLatitude;
    const refLng = gpsPolicy.targetLongitude;
    const refRadius = gpsPolicy.radiusMeters;
    const maxAccuracyMeters = gpsPolicy.maxAccuracyMeters;

    if (!isValidLatitude(refLat) || !isValidLongitude(refLng) || !Number.isFinite(refRadius) || refRadius <= 0) {
      return res.status(500).json(buildGpsValidationError({
        message: "Koordinat titik absensi belum dikonfigurasi. Hubungi operator.",
        reason: "GPS_NOT_CONFIGURED",
        accuracyMeters: accuracyMetersValue == null ? null : Math.round(accuracyMetersValue),
        maxAccuracyMeters: Number.isFinite(maxAccuracyMeters) ? maxAccuracyMeters : null,
        allowedRadiusMeters: Number.isFinite(refRadius) ? refRadius : null
      }));
    }

    const distanceMeters = haversineDistanceMeters(userLatitude, userLongitude, refLat, refLng);

    if (accuracyMetersValue != null && Number.isFinite(maxAccuracyMeters) && accuracyMetersValue > maxAccuracyMeters) {
      return res.status(400).json(buildGpsValidationError({
        message: "Akurasi GPS terlalu rendah. Coba pindah ke area terbuka atau aktifkan mode akurasi tinggi.",
        reason: "GPS_ACCURACY_TOO_LOW",
        accuracyMeters: Math.round(accuracyMetersValue),
        maxAccuracyMeters,
        distanceMeters: Math.round(distanceMeters),
        allowedRadiusMeters: refRadius
      }));
    }

    if (distanceMeters > refRadius) {
      return res.status(400).json(buildGpsValidationError({
        message: "Lokasi di luar radius absensi.",
        reason: "OUTSIDE_RADIUS",
        accuracyMeters: accuracyMetersValue == null ? null : Math.round(accuracyMetersValue),
        maxAccuracyMeters,
        distanceMeters: Math.round(distanceMeters),
        allowedRadiusMeters: refRadius
      }));
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
        [todayRecord.rows[0].id, userLatitude, userLongitude, accuracyMetersValue, distanceMeters]
      );
    } else {
      await query(
        `
        INSERT INTO attendance_records (
          id, student_id, attendance_date, status, check_in_at,
          check_in_lat, check_in_lng, accuracy_meters, distance_meters, within_radius
        ) VALUES ($1, $2, (NOW() AT TIME ZONE 'Asia/Jakarta')::date, 'Hadir', NOW(), $3, $4, $5, $6, TRUE)
        `,
        [recordId, resolvedStudentId, userLatitude, userLongitude, accuracyMetersValue, distanceMeters]
      );
    }

    res.status(201).json({
      message: "Check-in berhasil.",
      accepted: true,
      accuracyMeters: accuracyMetersValue == null ? null : Math.round(accuracyMetersValue),
      maxAccuracyMeters,
      distanceMeters: Math.round(distanceMeters),
      allowedRadiusMeters: refRadius
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

    const { studentId, latitude, longitude, accuracy, forceEarlyCheckout, earlyCheckoutAcknowledged } = req.body || {};
    const studentIdInput = role === "mahasiswa" ? (req.authUser?.id || studentId) : studentId;
    const userLatitude = parseGpsNumber(latitude);
    const userLongitude = parseGpsNumber(longitude);
    const accuracyMetersValue = accuracy == null ? null : parseGpsNumber(accuracy);

    if (
      !studentIdInput ||
      !isValidLatitude(userLatitude) ||
      !isValidLongitude(userLongitude) ||
      (accuracy != null && (!Number.isFinite(accuracyMetersValue) || accuracyMetersValue < 0))
    ) {
      return res.status(400).json(buildGpsValidationError({
        message: "Payload GPS tidak valid. studentId, latitude, dan longitude wajib valid.",
        reason: "INVALID_GPS_PAYLOAD",
        accuracyMeters: accuracyMetersValue == null ? null : Math.round(accuracyMetersValue)
      }));
    }

    const resolvedStudentId = await resolveStudentId(studentIdInput);
    if (!resolvedStudentId) {
      return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    }

    const studentResult = await query(
      `
      SELECT s.id, s.user_id, s.nim, s.tipe, u.name,
             TO_CHAR(s.created_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS active_start_date
      FROM students s
      JOIN users u ON u.id = s.user_id
      WHERE s.id = $1
      LIMIT 1
      `,
      [resolvedStudentId]
    );

    if (studentResult.rowCount === 0) {
      return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    }

    const student = studentResult.rows[0];

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

    const settings = await getSettingsAsync();
    const attendanceRules = getAttendanceRules(settings);
    const durationHoursValue = calculateDurationHours(todayRecord.rows[0].check_in_at);
    const durationHours = roundHours(durationHoursValue);
    const requiredHours = attendanceRules.magangMinCheckoutHours;
    const isEarlyMagangCheckout =
      student.tipe === "Magang" &&
      attendanceRules.earlyCheckoutWarning === true &&
      durationHoursValue < requiredHours;

    if (isEarlyMagangCheckout && !(forceEarlyCheckout === true && earlyCheckoutAcknowledged === true)) {
      return res.status(409).json({
        message: "Durasi magang belum memenuhi batas minimum checkout.",
        earlyCheckoutWarning: true,
        durationHours,
        requiredHours
      });
    }

    await ensureAttendanceColumns();
    await query(
      `
      UPDATE attendance_records
      SET check_out_at = NOW(),
          check_out_lat = $2,
          check_out_lng = $3,
          check_out_accuracy_meters = $4,
          updated_at = NOW()
      WHERE id = $1
      `,
      [todayRecord.rows[0].id, userLatitude, userLongitude, accuracyMetersValue]
    );

    let operatorNotified = false;
    if (isEarlyMagangCheckout) {
      const notifiedCount = await notifyOperatorsAboutEarlyCheckout({
        attendanceRecordId: todayRecord.rows[0].id,
        student,
        durationHours,
        requiredHours
      });
      operatorNotified = notifiedCount > 0;
    }

    res.json({
      message: "Check-out berhasil.",
      ...(isEarlyMagangCheckout
        ? {
            earlyCheckoutWarning: true,
            operatorNotified,
            durationHours,
            requiredHours
          }
        : {})
    });
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

    const studentResult = await query(
      `
      SELECT s.id, s.user_id, s.nim, s.tipe, u.name,
             TO_CHAR(s.created_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS active_start_date
      FROM students s
      JOIN users u ON u.id = s.user_id
      WHERE s.id = $1
      LIMIT 1
      `,
      [resolvedStudentId]
    );

    if (studentResult.rowCount === 0) {
      return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    }

    const student = studentResult.rows[0];

    const monthValue = String(month || getJakartaDateIso().slice(0, 7));
    const { startDate, endDate } = getMonthBounds(`${monthValue}-01`);
    const todayIso = getJakartaDateIso();
    const activeStartDate = student.active_start_date || startDate;
    const effectiveStartDate = maxIsoDate(startDate, activeStartDate);
    const effectiveEndDate = minIsoDate(endDate, todayIso);

    const attendanceRows = await query(
      `
      SELECT TO_CHAR(attendance_date, 'YYYY-MM-DD') AS attendance_date_text,
             check_in_at,
             check_out_at
      FROM attendance_records
      WHERE student_id = $1
        AND TO_CHAR(attendance_date, 'YYYY-MM') = $2
        AND attendance_date >= $3::date
        AND attendance_date <= $4::date
      ORDER BY attendance_date DESC
      `,
      [resolvedStudentId, monthValue, effectiveStartDate, effectiveEndDate]
    );

    const leaves = await query(
      `
      SELECT periode_start, periode_end
      FROM leave_requests
      WHERE student_id = $1
        AND status = 'Disetujui'
        AND TO_CHAR(periode_start, 'YYYY-MM') <= $2
        AND TO_CHAR(periode_end, 'YYYY-MM') >= $2
        AND periode_end >= $3::date
        AND periode_start <= $4::date
      `,
      [resolvedStudentId, monthValue, effectiveStartDate, effectiveEndDate]
    );

    const { attendanceMap, leaveSet, history, summary } = buildAttendanceHistory({
      startDate: effectiveStartDate,
      endDate: effectiveEndDate,
      attendanceRows: attendanceRows.rows,
      leaveRows: leaves.rows,
      activeStartDate
    });

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
    const attendanceRules = getAttendanceRules(settings);
    const gpsPolicy = buildGpsPolicy(settings);

    res.json({
      month: monthValue,
      student: {
        id: student.id,
        userId: student.user_id,
        name: student.name,
        nim: student.nim,
        tipe: student.tipe
      },
      attendanceRules,
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
      gpsPolicy,
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
