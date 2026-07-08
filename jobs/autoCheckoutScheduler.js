const { query } = require("../db/pool");
const { getSettingsAsync } = require("../config/systemSettingsStore");
const {
  createNotification,
  hasNotificationDispatch,
  recordNotificationDispatch
} = require("../utils/notificationService");
const {
  createCheckoutMissing22Locks,
  createWfhCheckinMissingLocks
} = require("../utils/studentAccessLocks");
const { findNonWorkingDayForDate } = require("../utils/holidays");

const TIMEZONE = "Asia/Jakarta";
const ONE_MINUTE = 60 * 1000;
const EVENT_ID = "auto_checkout_attendance";
const AUTO_REASON = "AUTO_CHECKOUT_22_00";

let ensureColumnsPromise = null;

function getJakartaNowParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
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

function normalizeTimeValue(value, fallback = "22:00") {
  const normalized = String(value || "").trim();
  return /^\d{2}:\d{2}$/.test(normalized) ? normalized : fallback;
}

async function ensureAttendanceAutoCheckoutColumns() {
  if (!ensureColumnsPromise) {
    ensureColumnsPromise = query(`
      ALTER TABLE attendance_records
      ADD COLUMN IF NOT EXISTS check_out_accuracy_meters DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS checkout_source TEXT,
      ADD COLUMN IF NOT EXISTS auto_checkout BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS auto_checkout_reason TEXT
    `);
  }
  await ensureColumnsPromise;
}

async function fetchOperatorIds() {
  const result = await query("SELECT id FROM users WHERE role = 'operator' AND is_active = TRUE");
  return result.rows.map((row) => row.id);
}

async function notifyRecipient({ recipientUserId, title, body, referenceKey, scheduleSlot, payload }) {
  const alreadySent = await hasNotificationDispatch({
    eventId: EVENT_ID,
    recipientUserId,
    referenceKey,
    scheduleSlot
  });

  if (alreadySent) return false;

  const notification = await createNotification({
    recipientUserId,
    senderUserId: null,
    type: "pengumuman",
    eventId: EVENT_ID,
    title,
    body
  });

  if (!notification.sent || !notification.id) return false;

  await recordNotificationDispatch({
    eventId: EVENT_ID,
    recipientUserId,
    referenceKey,
    scheduleSlot,
    notificationId: notification.id,
    payload
  });

  return true;
}

async function notifyAutoCheckout({ rows, scheduleSlot }) {
  const operatorIds = await fetchOperatorIds();
  let operatorNotifications = 0;
  let studentNotifications = 0;

  for (const row of rows) {
    const referenceKey = `${row.id}:${row.student_id}`;
    const payload = {
      attendanceRecordId: row.id,
      studentId: row.student_id,
      attendanceDate: row.attendance_date_text,
      checkoutTime: row.check_out_at
    };

    for (const operatorId of operatorIds) {
      const sent = await notifyRecipient({
        recipientUserId: operatorId,
        title: "Auto Checkout Absensi",
        body: `${row.student_name} (${row.nim || "-"}) otomatis checkout oleh sistem pada ${row.attendance_date_text} pukul ${scheduleSlot} WIB.`,
        referenceKey,
        scheduleSlot,
        payload
      });
      if (sent) operatorNotifications += 1;
    }

    if (row.recipient_user_id) {
      const sent = await notifyRecipient({
        recipientUserId: row.recipient_user_id,
        title: "Checkout Otomatis Sistem",
        body: `Absensi Anda pada ${row.attendance_date_text} otomatis checkout pukul ${scheduleSlot} WIB karena belum checkout manual.`,
        referenceKey,
        scheduleSlot,
        payload
      });
      if (sent) studentNotifications += 1;
    }
  }

  return { operatorNotifications, studentNotifications };
}

async function processAutoCheckout({ targetDate, checkoutTime }) {
  await ensureAttendanceAutoCheckoutColumns();

  const settings = await getSettingsAsync();
  const nonWorkingDay = findNonWorkingDayForDate(settings, targetDate);
  const shouldCreateAttendanceLocks = !nonWorkingDay;

  const result = await query(
    `
    WITH updated AS (
      UPDATE attendance_records ar
      SET check_out_at = ($1::date + $2::time) AT TIME ZONE 'Asia/Jakarta',
          check_out_lat = NULL,
          check_out_lng = NULL,
          check_out_accuracy_meters = NULL,
          checkout_source = 'SYSTEM_AUTO',
          auto_checkout = TRUE,
          auto_checkout_reason = $3,
          updated_at = NOW()
      WHERE ar.attendance_date = $1::date
        AND ar.status IN ('Hadir', 'WFH')
        AND ar.check_in_at IS NOT NULL
        AND ar.check_in_at <= (($1::date + $2::time) AT TIME ZONE 'Asia/Jakarta')
        AND ar.check_out_at IS NULL
      RETURNING ar.id, ar.student_id, ar.attendance_date, ar.status, ar.check_out_at
    )
    SELECT updated.id,
           updated.student_id,
           TO_CHAR(updated.attendance_date, 'YYYY-MM-DD') AS attendance_date_text,
           updated.status,
           updated.check_out_at,
           s.user_id AS recipient_user_id,
           s.tipe AS student_type,
           s.nim,
           u.name AS student_name,
           EXISTS (
             SELECT 1
             FROM leave_requests lr
             WHERE lr.student_id = updated.student_id
               AND lr.status = 'Disetujui'
               AND updated.attendance_date BETWEEN lr.periode_start AND lr.periode_end
           ) AS has_approved_leave
    FROM updated
    JOIN students s ON s.id = updated.student_id
    JOIN users u ON u.id = s.user_id
    `,
    [targetDate, checkoutTime, AUTO_REASON]
  );

  const missingCheckoutIds = shouldCreateAttendanceLocks
    ? result.rows
        .filter((row) => row.status === "WFH" || (row.student_type === "Magang" && row.has_approved_leave !== true))
        .map((row) => row.student_id)
    : [];
  const accessLockIds = await createCheckoutMissing22Locks({
    studentIds: missingCheckoutIds,
    date: targetDate
  });

  const missingWfhCheckin = shouldCreateAttendanceLocks
    ? await query(
    `
    SELECT DISTINCT lr.student_id
    FROM leave_requests lr
    JOIN students s ON s.id = lr.student_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN attendance_records ar
      ON ar.student_id = lr.student_id
     AND ar.attendance_date = $1::date
    WHERE lr.status = 'Disetujui'
      AND lr.jenis_pengajuan = 'wfh'
      AND $1::date BETWEEN lr.periode_start AND lr.periode_end
      AND s.status = 'Aktif'
      AND u.is_active = TRUE
      AND ar.check_in_at IS NULL
    `,
    [targetDate]
  )
    : { rows: [] };
  const wfhCheckinMissingIds = missingWfhCheckin.rows.map((row) => row.student_id);
  const wfhCheckinMissingLockIds = await createWfhCheckinMissingLocks({
    studentIds: wfhCheckinMissingIds,
    date: targetDate
  });

  const notifications = await notifyAutoCheckout({
    rows: result.rows,
    scheduleSlot: checkoutTime
  });

  return {
    processed: result.rowCount,
    rows: result.rows,
    accessLocks: {
      reason: "CHECKOUT_MISSING_22",
      studentIds: missingCheckoutIds,
      ids: accessLockIds,
      wfhCheckinMissingReason: "WFH_CHECKIN_MISSING",
      wfhCheckinMissingStudentIds: wfhCheckinMissingIds,
      wfhCheckinMissingIds: wfhCheckinMissingLockIds,
      nonWorkingDay
    },
    notifications
  };
}

async function recoverMissedAutoCheckout({ today, checkoutTime }) {
  await ensureAttendanceAutoCheckoutColumns();

  const missedDates = await query(
    `
    SELECT DISTINCT attendance_date::text AS attendance_date
    FROM (
      SELECT attendance_date
      FROM attendance_records
      WHERE attendance_date < $1::date
        AND status IN ('Hadir', 'WFH')
        AND check_in_at IS NOT NULL
        AND check_out_at IS NULL

      UNION

      SELECT wfh_day::date AS attendance_date
      FROM leave_requests lr
      CROSS JOIN LATERAL generate_series(lr.periode_start, lr.periode_end, interval '1 day') AS wfh_day
      LEFT JOIN attendance_records ar
        ON ar.student_id = lr.student_id
       AND ar.attendance_date = wfh_day::date
      WHERE lr.status = 'Disetujui'
        AND lr.jenis_pengajuan = 'wfh'
        AND wfh_day::date < $1::date
        AND ar.check_in_at IS NULL
    ) missed
    ORDER BY attendance_date ASC
    `,
    [today]
  );

  const results = [];
  for (const row of missedDates.rows) {
    results.push(await processAutoCheckout({
      targetDate: row.attendance_date,
      checkoutTime
    }));
  }
  return results;
}

async function runAutoCheckoutCycle(now = new Date()) {
  const settings = await getSettingsAsync();
  const attendanceRules = settings?.attendanceRules || {};
  const enabled = attendanceRules.autoCheckoutEnabled !== false;
  const checkoutTime = normalizeTimeValue(attendanceRules.autoCheckoutTime, "22:00");
  const nowParts = getJakartaNowParts(now);

  if (!enabled) {
    return { ran: false, reason: "disabled", now: nowParts };
  }

  const recovery = await recoverMissedAutoCheckout({
    today: nowParts.date,
    checkoutTime
  });

  let currentDay = null;
  if (nowParts.time >= checkoutTime) {
    currentDay = await processAutoCheckout({
      targetDate: nowParts.date,
      checkoutTime
    });
  }

  const processed = recovery.reduce((sum, item) => sum + item.processed, 0) + (currentDay?.processed || 0);

  return {
    ran: processed > 0,
    now: nowParts,
    checkoutTime,
    processed,
    recovery,
    currentDay
  };
}

async function runSchedulerTick() {
  try {
    const result = await runAutoCheckoutCycle();
    if (result.ran) {
      console.log("[AutoCheckoutScheduler] Cycle executed:", JSON.stringify({
        now: result.now,
        checkoutTime: result.checkoutTime,
        processed: result.processed
      }));
    }
    return result;
  } catch (error) {
    console.error("[AutoCheckoutScheduler] Cycle failed:", error.message);
    return {
      ran: false,
      reason: "error",
      error: error.message
    };
  }
}

function startMonitoring() {
  console.log("[AutoCheckoutScheduler] Starting auto checkout scheduler (checks every minute)...");
  runSchedulerTick().catch(() => {});
  setInterval(() => {
    runSchedulerTick().catch(() => {});
  }, ONE_MINUTE);
}

module.exports = {
  getJakartaNowParts,
  normalizeTimeValue,
  processAutoCheckout,
  runAutoCheckoutCycle,
  runSchedulerTick,
  startMonitoring
};

if (require.main === module) {
  runSchedulerTick()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
