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
  formatAttendanceDuration,
  formatAttendanceTime,
  getJakartaDateIso,
  getMonthBounds,
  maxIsoDate,
  minIsoDate
} = require("../../utils/attendanceHistory");
const {
  createAttendanceAbsentLocks,
  createCheckoutMissing22Locks,
  createWorkHoursUnder8Locks
} = require("../../utils/studentAccessLocks");
const { requireSafeId } = require("../../utils/securityValidation");

const router = express.Router();

router.param("id", (req, res, next, value) => {
  try {
    req.params.id = requireSafeId(value, "id");
    next();
  } catch (error) {
    next(error);
  }
});

const ATTENDANCE_TIMEZONE = "Asia/Jakarta";
const ATTENDANCE_ABSENT_LOCK_AFTER = "10:00";
const ATTENDANCE_CHECKIN_CUTOFF = "22:00";
const ATTENDANCE_MISSING_CHECKOUT_LOCK_AFTER = "22:00";
const ATTENDANCE_AUTO_CHECKOUT_REASON_22 = "AUTO_CHECKOUT_22_00";

function getJakartaTimeHm(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: ATTENDANCE_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23"
  });

  const parts = formatter.formatToParts(date).reduce((acc, item) => {
    acc[item.type] = item.value;
    return acc;
  }, {});

  const hour = parts.hour === "24" ? "00" : parts.hour;

  return `${hour}:${parts.minute}`;
}

function canCreateAttendanceAbsentLock(date = new Date()) {
  return getJakartaTimeHm(date) >= ATTENDANCE_ABSENT_LOCK_AFTER;
}

function isCheckInAfterCutoff(date = new Date()) {
  return getJakartaTimeHm(date) >= ATTENDANCE_CHECKIN_CUTOFF;
}

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
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

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
    earlyCheckoutWarning: Boolean(settings.attendanceRules?.earlyCheckoutWarning ?? true),
    autoCheckoutEnabled: Boolean(settings.attendanceRules?.autoCheckoutEnabled ?? true),
    autoCheckoutTime: String(settings.attendanceRules?.autoCheckoutTime || "22:00")
  };
}

async function ensureAttendanceColumns() {
  if (!ensureAttendanceColumnsPromise) {
    ensureAttendanceColumnsPromise = query(`
      ALTER TABLE attendance_records
      ADD COLUMN IF NOT EXISTS check_out_accuracy_meters DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS checkout_source TEXT,
      ADD COLUMN IF NOT EXISTS auto_checkout BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS auto_checkout_reason TEXT,
      ADD COLUMN IF NOT EXISTS note TEXT
    `);
  }

  await ensureAttendanceColumnsPromise;
}

function isValidIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function isValidTimeValue(value) {
  return /^\d{2}:\d{2}$/.test(String(value || ""));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function getStatusColor(status) {
  if (status === "Hadir") return "green";
  if (status === "Cuti") return "amber";
  if (status === "Izin") return "blue";
  if (status === "Sakit") return "rose";
  if (status === "WFH") return "sky";
  if (status === "Libur") return "gray";
  return "red";
}

function resolveManualStatus({ status, checkIn, checkOut }) {
  if (status) return status;
  if (checkIn || checkOut) return "Hadir";
  return null;
}

function validateAttendanceStatus(status) {
  return ["Hadir", "Cuti", "Izin", "Sakit", "WFH", "Tidak Hadir"].includes(status);
}

function compareTimes(checkIn, checkOut) {
  if (!checkIn || !checkOut) return 0;
  return String(checkOut).localeCompare(String(checkIn));
}

function formatDbTime(value) {
  return value ? String(value).slice(0, 5) : null;
}

function normalizeLeaveType(type) {
  switch (String(type || "").toLowerCase()) {
    case "izin":
      return "izin";
    case "sakit":
      return "sakit";
    case "wfh":
      return "wfh";
    case "cuti":
    default:
      return "cuti";
  }
}

function mapAttendanceRecord(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    date: row.attendance_date_text || row.attendance_date,
    checkIn: formatAttendanceTime(row.check_in_at),
    checkOut: formatAttendanceTime(row.check_out_at),
    in: formatAttendanceTime(row.check_in_at),
    out: formatAttendanceTime(row.check_out_at),
    duration: formatAttendanceDuration(row.check_in_at, row.check_out_at),
    status: row.status,
    statusColor: getStatusColor(row.status),
    checkInLatitude: row.check_in_lat == null ? null : Number(row.check_in_lat),
    checkInLongitude: row.check_in_lng == null ? null : Number(row.check_in_lng),
    checkInAccuracy: row.accuracy_meters == null ? null : Number(row.accuracy_meters),
    checkOutLatitude: row.check_out_lat == null ? null : Number(row.check_out_lat),
    checkOutLongitude: row.check_out_lng == null ? null : Number(row.check_out_lng),
    checkOutAccuracy: row.check_out_accuracy_meters == null ? null : Number(row.check_out_accuracy_meters),
    autoCheckout: Boolean(row.auto_checkout),
    checkoutSource: row.checkout_source || null,
    autoCheckoutReason: row.auto_checkout_reason || null,
    note: row.note || null
  };
}

async function fetchAttendanceRecordById(id) {
  await ensureAttendanceColumns();

  const result = await query(
    `
    SELECT id, student_id, TO_CHAR(attendance_date, 'YYYY-MM-DD') AS attendance_date_text,
           check_in_at, check_out_at, check_in_lat, check_in_lng,
           check_out_lat, check_out_lng, accuracy_meters, check_out_accuracy_meters,
           checkout_source, auto_checkout, auto_checkout_reason, note, status
    FROM attendance_records
    WHERE id = $1
    LIMIT 1
    `,
    [id]
  );

  return result.rows[0] || null;
}

async function recordAttendanceAudit({
  req,
  action,
  actionType,
  attendanceRecordId,
  studentId,
  before = null,
  after = null
}) {
  const auditId = `AUD-ATT-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const actedByUserId = req.authUser?.id || String(req.headers["x-user-id"] || "").trim() || null;

  await query(
    `
    INSERT INTO audit_logs (id, user_id, user_role, action, target, ip, detail)
    VALUES ($1, $2, 'Operator', $3, $4, $5, $6::jsonb)
    `,
    [
      auditId,
      actedByUserId,
      action,
      `attendance:${attendanceRecordId}`,
      req.ip || null,
      JSON.stringify({
        actionType,
        attendanceRecordId,
        studentId,
        actedByUserId,
        actedByRole: "operator",
        actedAt: new Date().toISOString(),
        before,
        after
      })
    ]
  );
}

async function ensureStudentExists(studentId) {
  const resolvedStudentId = await resolveStudentId(studentId);
  if (!resolvedStudentId) return null;

  const result = await query("SELECT id FROM students WHERE id = $1 LIMIT 1", [resolvedStudentId]);
  return result.rows[0]?.id || null;
}

async function hasApprovedLeaveOnDate(studentId, dateIso) {
  const result = await query(
    `
    SELECT id
    FROM leave_requests
    WHERE student_id = $1
      AND status = 'Disetujui'
      AND $2::date BETWEEN periode_start AND periode_end
    LIMIT 1
    `,
    [studentId, dateIso]
  );

  return result.rowCount > 0;
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

async function notifyOperatorsAboutEarlyCheckout({
  attendanceRecordId,
  student,
  durationHours,
  requiredHours
}) {
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

    if (isCheckInAfterCutoff()) {
      return res.status(400).json({
        message: "Check-in tidak diizinkan setelah pukul 22.00 WIB.",
        code: "CHECKIN_AFTER_CUTOFF"
      });
    }

    const { studentId, latitude, longitude, accuracy } = req.body || {};
    const studentIdInput = role === "mahasiswa" ? req.authUser?.id || studentId : studentId;
    const userLatitude = parseGpsNumber(latitude);
    const userLongitude = parseGpsNumber(longitude);
    const accuracyMetersValue = accuracy == null ? null : parseGpsNumber(accuracy);

    if (
      !studentIdInput ||
      !isValidLatitude(userLatitude) ||
      !isValidLongitude(userLongitude) ||
      (accuracy != null && (!Number.isFinite(accuracyMetersValue) || accuracyMetersValue < 0))
    ) {
      return res.status(400).json(
        buildGpsValidationError({
          message: "Payload GPS tidak valid. studentId, latitude, dan longitude wajib valid.",
          reason: "INVALID_GPS_PAYLOAD",
          accuracyMeters: accuracyMetersValue == null ? null : Math.round(accuracyMetersValue)
        })
      );
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
      return res.status(500).json(
        buildGpsValidationError({
          message: "Koordinat titik absensi belum dikonfigurasi. Hubungi operator.",
          reason: "GPS_NOT_CONFIGURED",
          accuracyMeters: accuracyMetersValue == null ? null : Math.round(accuracyMetersValue),
          maxAccuracyMeters: Number.isFinite(maxAccuracyMeters) ? maxAccuracyMeters : null,
          allowedRadiusMeters: Number.isFinite(refRadius) ? refRadius : null
        })
      );
    }

    const distanceMeters = haversineDistanceMeters(userLatitude, userLongitude, refLat, refLng);

    if (accuracyMetersValue != null && Number.isFinite(maxAccuracyMeters) && accuracyMetersValue > maxAccuracyMeters) {
      return res.status(400).json(
        buildGpsValidationError({
          message: "Akurasi GPS terlalu rendah. Coba pindah ke area terbuka atau aktifkan mode akurasi tinggi.",
          reason: "GPS_ACCURACY_TOO_LOW",
          accuracyMeters: Math.round(accuracyMetersValue),
          maxAccuracyMeters,
          distanceMeters: Math.round(distanceMeters),
          allowedRadiusMeters: refRadius
        })
      );
    }

    if (distanceMeters > refRadius) {
      return res.status(400).json(
        buildGpsValidationError({
          message: "Lokasi di luar radius absensi.",
          reason: "OUTSIDE_RADIUS",
          accuracyMeters: accuracyMetersValue == null ? null : Math.round(accuracyMetersValue),
          maxAccuracyMeters,
          distanceMeters: Math.round(distanceMeters),
          allowedRadiusMeters: refRadius
        })
      );
    }

    await ensureAttendanceColumns();

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
            check_out_accuracy_meters = NULL,
            checkout_source = NULL,
            auto_checkout = FALSE,
            auto_checkout_reason = NULL,
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
    const studentIdInput = role === "mahasiswa" ? req.authUser?.id || studentId : studentId;
    const userLatitude = parseGpsNumber(latitude);
    const userLongitude = parseGpsNumber(longitude);
    const accuracyMetersValue = accuracy == null ? null : parseGpsNumber(accuracy);

    if (
      !studentIdInput ||
      !isValidLatitude(userLatitude) ||
      !isValidLongitude(userLongitude) ||
      (accuracy != null && (!Number.isFinite(accuracyMetersValue) || accuracyMetersValue < 0))
    ) {
      return res.status(400).json(
        buildGpsValidationError({
          message: "Payload GPS tidak valid. studentId, latitude, dan longitude wajib valid.",
          reason: "INVALID_GPS_PAYLOAD",
          accuracyMeters: accuracyMetersValue == null ? null : Math.round(accuracyMetersValue)
        })
      );
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
    const todayIso = getJakartaDateIso();

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

    if (role === "mahasiswa") {
      const logbookToday = await query(
        `
        SELECT id
        FROM logbook_entries
        WHERE student_id = $1
          AND date = $2::date
        LIMIT 1
        `,
        [resolvedStudentId, todayIso]
      );

      if (logbookToday.rowCount === 0) {
        return res.status(409).json({
          message: "Isi logbook hari ini terlebih dahulu sebelum check-out.",
          logbookRequired: true,
          date: todayIso
        });
      }
    }

    const settings = await getSettingsAsync();
    const attendanceRules = getAttendanceRules(settings);
    const durationHoursValue = calculateDurationHours(todayRecord.rows[0].check_in_at);
    const durationHours = roundHours(durationHoursValue);
    const requiredHours = attendanceRules.magangMinCheckoutHours;

    const isUnderMinMagangCheckout =
      student.tipe === "Magang" &&
      durationHoursValue < requiredHours;
    const isEarlyMagangCheckout =
      isUnderMinMagangCheckout &&
      attendanceRules.earlyCheckoutWarning === true;

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
          checkout_source = 'USER_GPS',
          auto_checkout = FALSE,
          auto_checkout_reason = NULL,
          updated_at = NOW()
      WHERE id = $1
      `,
      [todayRecord.rows[0].id, userLatitude, userLongitude, accuracyMetersValue]
    );

    let operatorNotified = false;
    let accessLockCreated = false;

    if (isEarlyMagangCheckout) {
      const notifiedCount = await notifyOperatorsAboutEarlyCheckout({
        attendanceRecordId: todayRecord.rows[0].id,
        student,
        durationHours,
        requiredHours
      });

      operatorNotified = notifiedCount > 0;
    }

    if (isUnderMinMagangCheckout && !(await hasApprovedLeaveOnDate(resolvedStudentId, todayIso))) {
      const createdLockIds = await createWorkHoursUnder8Locks({
        studentIds: [resolvedStudentId],
        date: todayIso
      });
      accessLockCreated = createdLockIds.length > 0;
    }

    res.json({
      message: "Check-out berhasil.",
      ...(isUnderMinMagangCheckout
        ? {
            accessLockCreated,
            accessLockReason: "WORK_HOURS_UNDER_8"
          }
        : {}),
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
  "/records/:id",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);

    if (role !== "operator") {
      return res.status(403).json({ message: "Akses detail absensi hanya untuk operator." });
    }

    const record = await fetchAttendanceRecordById(req.params.id);

    if (!record) {
      return res.status(404).json({ message: "Data absensi tidak ditemukan." });
    }

    res.json(mapAttendanceRecord(record));
  })
);

router.post(
  "/records",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);

    if (role !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat menambah data absensi." });
    }

    await ensureAttendanceColumns();

    const { studentId, date, checkIn, checkOut, status, note } = req.body || {};
    const resolvedStudentId = await ensureStudentExists(studentId);

    if (!resolvedStudentId) {
      return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    }

    const normalizedDate = String(date || "").trim();
    const normalizedCheckIn = checkIn == null || checkIn === "" ? null : String(checkIn).trim();
    const normalizedCheckOut = checkOut == null || checkOut === "" ? null : String(checkOut).trim();
    const normalizedStatus = status == null || status === "" ? null : String(status).trim();

    if (!isValidIsoDate(normalizedDate)) {
      return res.status(400).json({ message: "date wajib format YYYY-MM-DD." });
    }

    if (normalizedCheckIn && !isValidTimeValue(normalizedCheckIn)) {
      return res.status(400).json({ message: "checkIn wajib format HH:mm." });
    }

    if (normalizedCheckOut && !isValidTimeValue(normalizedCheckOut)) {
      return res.status(400).json({ message: "checkOut wajib format HH:mm." });
    }

    if (normalizedCheckIn && normalizedCheckOut && compareTimes(normalizedCheckIn, normalizedCheckOut) < 0) {
      return res.status(400).json({ message: "checkOut tidak boleh lebih kecil dari checkIn pada tanggal yang sama." });
    }

    const finalStatus = resolveManualStatus({
      status: normalizedStatus,
      checkIn: normalizedCheckIn,
      checkOut: normalizedCheckOut
    });

    if (!finalStatus) {
      return res.status(400).json({ message: "Isi minimal status atau checkIn/checkOut." });
    }

    if (!validateAttendanceStatus(finalStatus)) {
      return res.status(400).json({ message: "status harus Hadir, Cuti, Izin, Sakit, WFH, atau Tidak Hadir." });
    }

    const duplicate = await query(
      `
      SELECT id
      FROM attendance_records
      WHERE student_id = $1 AND attendance_date = $2::date
      LIMIT 1
      `,
      [resolvedStudentId, normalizedDate]
    );

    if (duplicate.rowCount > 0) {
      return res.status(409).json({
        message: "Data absensi untuk mahasiswa dan tanggal ini sudah ada.",
        existingRecordId: duplicate.rows[0].id
      });
    }

    const recordId = `ATD-MAN-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

    await query(
      `
      INSERT INTO attendance_records (
        id, student_id, attendance_date, status, check_in_at, check_out_at,
        check_in_lat, check_in_lng, check_out_lat, check_out_lng,
        accuracy_meters, check_out_accuracy_meters, distance_meters, within_radius,
        checkout_source, auto_checkout, auto_checkout_reason, note
      )
      VALUES (
        $1, $2, $3::date, $4,
        CASE WHEN $5::text IS NULL THEN NULL ELSE (($3::date + $5::time) AT TIME ZONE 'Asia/Jakarta') END,
        CASE WHEN $6::text IS NULL THEN NULL ELSE (($3::date + $6::time) AT TIME ZONE 'Asia/Jakarta') END,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, FALSE,
        'OPERATOR_MANUAL', FALSE, NULL, $7
      )
      `,
      [
        recordId,
        resolvedStudentId,
        normalizedDate,
        finalStatus,
        normalizedCheckIn,
        normalizedCheckOut,
        note == null ? null : String(note)
      ]
    );

    const created = await fetchAttendanceRecordById(recordId);

    await recordAttendanceAudit({
      req,
      action: "Create",
      actionType: "CREATE_ATTENDANCE",
      attendanceRecordId: recordId,
      studentId: resolvedStudentId,
      after: mapAttendanceRecord(created)
    });

    res.status(201).json(mapAttendanceRecord(created));
  })
);

router.patch(
  "/records/:id",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);

    if (role !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat mengubah data absensi." });
    }

    await ensureAttendanceColumns();

    const existing = await query(
      `
      SELECT id, student_id, TO_CHAR(attendance_date, 'YYYY-MM-DD') AS attendance_date_text,
             TO_CHAR(check_in_at AT TIME ZONE 'Asia/Jakarta', 'HH24:MI') AS check_in_time,
             TO_CHAR(check_out_at AT TIME ZONE 'Asia/Jakarta', 'HH24:MI') AS check_out_time,
             status, note
      FROM attendance_records
      WHERE id = $1
      LIMIT 1
      `,
      [req.params.id]
    );

    if (existing.rowCount === 0) {
      return res.status(404).json({ message: "Data absensi tidak ditemukan." });
    }

    const before = await fetchAttendanceRecordById(req.params.id);
    const body = req.body || {};
    const current = existing.rows[0];

    const finalDate = hasOwn(body, "date") ? String(body.date || "").trim() : current.attendance_date_text;

    const finalCheckIn = hasOwn(body, "checkIn")
      ? body.checkIn == null || body.checkIn === ""
        ? null
        : String(body.checkIn).trim()
      : formatDbTime(current.check_in_time);

    const finalCheckOut = hasOwn(body, "checkOut")
      ? body.checkOut == null || body.checkOut === ""
        ? null
        : String(body.checkOut).trim()
      : formatDbTime(current.check_out_time);

    const explicitStatus = hasOwn(body, "status")
      ? body.status == null || body.status === ""
        ? null
        : String(body.status).trim()
      : current.status;

    const finalStatus = resolveManualStatus({
      status: explicitStatus,
      checkIn: finalCheckIn,
      checkOut: finalCheckOut
    });

    const finalNote = hasOwn(body, "note") ? (body.note == null ? null : String(body.note)) : current.note;

    if (!isValidIsoDate(finalDate)) {
      return res.status(400).json({ message: "date wajib format YYYY-MM-DD." });
    }

    if (finalCheckIn && !isValidTimeValue(finalCheckIn)) {
      return res.status(400).json({ message: "checkIn wajib format HH:mm." });
    }

    if (finalCheckOut && !isValidTimeValue(finalCheckOut)) {
      return res.status(400).json({ message: "checkOut wajib format HH:mm." });
    }

    if (finalCheckIn && finalCheckOut && compareTimes(finalCheckIn, finalCheckOut) < 0) {
      return res.status(400).json({ message: "checkOut tidak boleh lebih kecil dari checkIn pada tanggal yang sama." });
    }

    if (!finalStatus) {
      return res.status(400).json({ message: "Isi minimal status atau checkIn/checkOut." });
    }

    if (!validateAttendanceStatus(finalStatus)) {
      return res.status(400).json({ message: "status harus Hadir, Cuti, Izin, Sakit, WFH, atau Tidak Hadir." });
    }

    const duplicate = await query(
      `
      SELECT id
      FROM attendance_records
      WHERE student_id = $1
        AND attendance_date = $2::date
        AND id <> $3
      LIMIT 1
      `,
      [current.student_id, finalDate, req.params.id]
    );

    if (duplicate.rowCount > 0) {
      return res.status(409).json({
        message: "Data absensi untuk mahasiswa dan tanggal ini sudah ada.",
        existingRecordId: duplicate.rows[0].id
      });
    }

    await query(
      `
      UPDATE attendance_records
      SET attendance_date = $2::date,
          status = $3,
          check_in_at = CASE WHEN $4::text IS NULL THEN NULL ELSE (($2::date + $4::time) AT TIME ZONE 'Asia/Jakarta') END,
          check_out_at = CASE WHEN $5::text IS NULL THEN NULL ELSE (($2::date + $5::time) AT TIME ZONE 'Asia/Jakarta') END,
          check_in_lat = NULL,
          check_in_lng = NULL,
          check_out_lat = NULL,
          check_out_lng = NULL,
          accuracy_meters = NULL,
          check_out_accuracy_meters = NULL,
          distance_meters = NULL,
          within_radius = FALSE,
          checkout_source = 'OPERATOR_EDIT',
          auto_checkout = FALSE,
          auto_checkout_reason = NULL,
          note = $6,
          updated_at = NOW()
      WHERE id = $1
      `,
      [req.params.id, finalDate, finalStatus, finalCheckIn, finalCheckOut, finalNote]
    );

    const updated = await fetchAttendanceRecordById(req.params.id);

    await recordAttendanceAudit({
      req,
      action: "Update",
      actionType: "UPDATE_ATTENDANCE",
      attendanceRecordId: req.params.id,
      studentId: current.student_id,
      before: mapAttendanceRecord(before),
      after: mapAttendanceRecord(updated)
    });

    res.json(mapAttendanceRecord(updated));
  })
);

router.delete(
  "/records/:id",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);

    if (role !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat menghapus data absensi." });
    }

    await ensureAttendanceColumns();

    const before = await fetchAttendanceRecordById(req.params.id);

    if (!before) {
      return res.status(404).json({ message: "Data absensi tidak ditemukan." });
    }

    await query("DELETE FROM attendance_records WHERE id = $1", [req.params.id]);

    await recordAttendanceAudit({
      req,
      action: "Delete",
      actionType: "DELETE_ATTENDANCE",
      attendanceRecordId: req.params.id,
      studentId: before.student_id,
      before: mapAttendanceRecord(before)
    });

    res.json({ message: "Data absensi berhasil dihapus." });
  })
);

router.get(
  "/monitor/today",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);

    if (role !== "operator") {
      return res.status(403).json({ message: "Akses monitor absensi hanya untuk operator." });
    }

    const todayIso = getJakartaDateIso();
    const currentTime = getJakartaTimeHm();
    const lockWindowOpen = canCreateAttendanceAbsentLock();
    const missingCheckoutWindowOpen = currentTime >= ATTENDANCE_MISSING_CHECKOUT_LOCK_AFTER;
    const settings = await getSettingsAsync();
    const attendanceRules = getAttendanceRules(settings);
    const magangMinCheckoutHours = attendanceRules.magangMinCheckoutHours;

    const studentsResult = await query(
      `
      SELECT s.id, s.tipe
      FROM students s
      JOIN users u ON u.id = s.user_id
      WHERE u.is_active = TRUE
      `
    );

    const attendanceResult = await query(
      `
      SELECT student_id, status, check_in_at, check_out_at, auto_checkout_reason,
             CASE
               WHEN check_in_at IS NOT NULL AND check_out_at IS NOT NULL
               THEN EXTRACT(EPOCH FROM (check_out_at - check_in_at)) / 3600.0
               ELSE NULL
             END AS duration_hours
      FROM attendance_records
      WHERE attendance_date = (NOW() AT TIME ZONE 'Asia/Jakarta')::date
      `
    );

    const leavesResult = await query(
      `
      SELECT DISTINCT ON (student_id)
        student_id,
        COALESCE(jenis_pengajuan, 'cuti') AS jenis_pengajuan
      FROM leave_requests
      WHERE status = 'Disetujui'
        AND (NOW() AT TIME ZONE 'Asia/Jakarta')::date BETWEEN periode_start AND periode_end
      ORDER BY student_id, tanggal_pengajuan DESC, id DESC
      `
    );

    const allStudentIds = studentsResult.rows.map((row) => row.id);
    const studentsById = new Map(studentsResult.rows.map((row) => [row.id, row]));
    const leaveSet = new Set(leavesResult.rows.map((row) => row.student_id));

    const leaveTypesByStudentId = {};
    for (const row of leavesResult.rows) {
      leaveTypesByStudentId[row.student_id] = normalizeLeaveType(row.jenis_pengajuan);
    }

    const attendanceMap = new Map(attendanceResult.rows.map((row) => [row.student_id, row]));

    const presentIds = [];
    const leaveIds = [];
    const absentIds = [];
    const noInformationIds = [];
    const reportedAbsentIds = [];
    const magangUnderHoursIds = [];
    const magangMissingCheckoutIds = [];

    allStudentIds.forEach((studentId) => {
      const student = studentsById.get(studentId);
      const attendance = attendanceMap.get(studentId);
      const status = attendance?.status;

      if (status === "Hadir") {
        presentIds.push(studentId);

        if (student?.tipe === "Magang" && !leaveSet.has(studentId)) {
          const durationHours =
            attendance.duration_hours == null ? null : Number(attendance.duration_hours);

          if (
            attendance.check_in_at &&
            attendance.check_out_at &&
            attendance.auto_checkout_reason !== ATTENDANCE_AUTO_CHECKOUT_REASON_22 &&
            Number.isFinite(durationHours) &&
            durationHours < magangMinCheckoutHours
          ) {
            magangUnderHoursIds.push(studentId);
          }

          if (
            missingCheckoutWindowOpen &&
            attendance.check_in_at &&
            (!attendance.check_out_at || attendance.auto_checkout_reason === ATTENDANCE_AUTO_CHECKOUT_REASON_22)
          ) {
            magangMissingCheckoutIds.push(studentId);
          }
        }

        return;
      }

      if (
        status === "Cuti" ||
        status === "Izin" ||
        status === "Sakit" ||
        status === "WFH" ||
        leaveSet.has(studentId)
      ) {
        leaveIds.push(studentId);

        if (!leaveTypesByStudentId[studentId]) {
          if (status === "Izin") {
            leaveTypesByStudentId[studentId] = "izin";
          } else if (status === "Sakit") {
            leaveTypesByStudentId[studentId] = "sakit";
          } else if (status === "WFH") {
            leaveTypesByStudentId[studentId] = "wfh";
          } else {
            leaveTypesByStudentId[studentId] = "cuti";
          }
        }

        return;
      }

      if (status) {
        reportedAbsentIds.push(studentId);
        return;
      }

      noInformationIds.push(studentId);

      if (lockWindowOpen) {
        absentIds.push(studentId);
      }
    });

    if (lockWindowOpen && absentIds.length > 0) {
      await createAttendanceAbsentLocks({
        studentIds: absentIds,
        date: todayIso
      });
    }

    const magangUnderHoursLockIds =
      magangUnderHoursIds.length > 0
        ? await createWorkHoursUnder8Locks({
            studentIds: magangUnderHoursIds,
            date: todayIso
          })
        : [];
    const magangMissingCheckoutLockIds =
      magangMissingCheckoutIds.length > 0
        ? await createCheckoutMissing22Locks({
            studentIds: magangMissingCheckoutIds,
            date: todayIso
          })
        : [];
    const magangLockedIds = [...new Set([...magangUnderHoursIds, ...magangMissingCheckoutIds])];

    res.json({
      date: todayIso,
      timezone: ATTENDANCE_TIMEZONE,
      currentTime,
      lockVisibleAfter: ATTENDANCE_ABSENT_LOCK_AFTER,
      magangMinCheckoutHours,
      missingCheckoutLockAfter: ATTENDANCE_MISSING_CHECKOUT_LOCK_AFTER,
      lockWindowOpen,
      missingCheckoutWindowOpen,
      presentIds,
      leaveIds,
      leaveTypesByStudentId,
      absentIds,
      reportedAbsentIds,
      noInformationIds,
      magangUnderHoursIds,
      magangMissingCheckoutIds,
      magangLockedIds,
      magangUnderHoursLockIds,
      magangMissingCheckoutLockIds
    });
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    const studentId = role === "mahasiswa" ? req.authUser?.id || req.query.studentId : req.query.studentId;
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

    await ensureAttendanceColumns();

    const attendanceRows = await query(
      `
      SELECT id,
             TO_CHAR(attendance_date, 'YYYY-MM-DD') AS attendance_date_text,
             check_in_at,
             check_out_at,
             checkout_source,
             auto_checkout,
             auto_checkout_reason,
             note,
             status
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
      SELECT 
        periode_start,
        periode_end,
        COALESCE(jenis_pengajuan, 'cuti') AS jenis_pengajuan
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

    const { attendanceMap, leaveSet, leaveMap, history, summary } = buildAttendanceHistory({
      startDate: effectiveStartDate,
      endDate: effectiveEndDate,
      attendanceRows: attendanceRows.rows,
      leaveRows: leaves.rows,
      activeStartDate
    });

    const todayAttendance = attendanceMap.get(todayIso);

    const todayStatus = leaveSet.has(todayIso)
      ? leaveMap.get(todayIso) || "Cuti"
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
        { name: "Izin", value: summary.izin, color: "#3B82F6" },
        { name: "Sakit", value: summary.sakit, color: "#F43F5E" },
        { name: "WFH", value: summary.wfh, color: "#0EA5E9" },
        { name: "Libur", value: summary.libur, color: "#94A3B8" }
      ],
      today: {
        checkIn: todayAttendance?.check_in_at
          ? new Date(todayAttendance.check_in_at).toLocaleTimeString("id-ID", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false
            })
          : "--:--",
        checkOut: todayAttendance?.check_out_at
          ? new Date(todayAttendance.check_out_at).toLocaleTimeString("id-ID", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false
            })
          : "--:--",
        status: todayStatus,
        autoCheckout: Boolean(todayAttendance?.auto_checkout),
        checkoutSource: todayAttendance?.checkout_source || null,
        autoCheckoutReason: todayAttendance?.auto_checkout_reason || null
      },
      gps: {
        latitude: Number(gps.latitude),
        longitude: Number(gps.longitude),
        radius: Number(gps.radius)
      },
      gpsPolicy,
      history: history
        .map((item) => ({
          id: item.id,
          date: item.dateLabel,
          in: item.in,
          out: item.out,
          duration: item.duration,
          status: item.status,
          statusColor: item.statusColor,
          autoCheckout: item.autoCheckout,
          checkoutSource: item.checkoutSource,
          autoCheckoutReason: item.autoCheckoutReason,
          note: item.note
        }))
        .reverse()
        .slice(0, 31)
    });
  })
);

module.exports = router;
