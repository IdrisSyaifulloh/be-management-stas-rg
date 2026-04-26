const { query } = require("../db/pool");
const {
  createNotification,
  getNotificationReminderSettings,
  hasNotificationDispatch,
  recordNotificationDispatch
} = require("../utils/notificationService");
const { getIsoWeekKey, recordDashboardReminder } = require("../utils/dashboardReminders");

const TIMEZONE = "Asia/Jakarta";
const ONE_MINUTE = 60 * 1000;

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

function normalizeTimeValue(value, fallback) {
  const normalized = String(value || "").trim();
  if (/^\d{2}:\d{2}$/.test(normalized)) return normalized;
  return fallback;
}

function resolveDueSlots(reminderSettings, nowParts) {
  const slotMap = {
    first: normalizeTimeValue(reminderSettings?.firstTime, "09:00"),
    second: normalizeTimeValue(reminderSettings?.secondTime, "15:00"),
    deadline: normalizeTimeValue(reminderSettings?.deadlineTime, "23:59")
  };

  return Object.entries(slotMap)
    .filter(([, time]) => time === nowParts.time)
    .map(([slot]) => slot);
}

async function dispatchLogbookReminderForSlot({ slot, referenceDate }) {
  const studentsResult = await query(
    `
    SELECT s.id AS student_id, s.user_id AS recipient_user_id, u.name AS student_name
    FROM students s
    JOIN users u ON u.id = s.user_id
    WHERE s.status = 'Aktif'
      AND NOT EXISTS (
        SELECT 1
        FROM logbook_entries le
        WHERE le.student_id = s.id
          AND le.date = $1::date
      )
    `,
    [referenceDate]
  );

  let sent = 0;
  let skipped = 0;

  for (const row of studentsResult.rows) {
    const referenceKey = `${referenceDate}:logbook_reminder`;
    const alreadyDispatched = await hasNotificationDispatch({
      eventId: "logbook_reminder",
      recipientUserId: row.recipient_user_id,
      referenceKey,
      scheduleSlot: slot
    });

    if (alreadyDispatched) {
      skipped += 1;
      continue;
    }

    const result = await createNotification({
      recipientUserId: row.recipient_user_id,
      senderUserId: null,
      type: "pengumuman",
      eventId: "logbook_reminder",
      title: "Pengingat Logbook Harian",
      body: `Halo ${row.student_name}, jangan lupa isi logbook untuk tanggal ${referenceDate}.`
    });

    if (result.sent) {
      await recordNotificationDispatch({
        eventId: "logbook_reminder",
        recipientUserId: row.recipient_user_id,
        referenceKey,
        scheduleSlot: slot,
        notificationId: result.id,
        payload: { studentId: row.student_id, referenceDate }
      });
      sent += 1;
    } else {
      skipped += 1;
    }
  }

  return { sent, skipped };
}

async function dispatchOperatorLogbookMissing({ slot, referenceDate, toleranceDays }) {
  if (slot !== "deadline") {
    return { sent: 0, skipped: 0 };
  }

  const thresholdDays = Math.max(1, Number(toleranceDays || 1));
  const operatorsResult = await query("SELECT id FROM users WHERE role = 'operator' AND is_active = TRUE");
  if (operatorsResult.rowCount === 0) return { sent: 0, skipped: 0 };

  const studentsResult = await query(
    `
    SELECT
      s.id AS student_id,
      s.user_id AS recipient_user_id,
      u.name AS student_name,
      COALESCE(MAX(le.date), DATE '1970-01-01') AS last_logbook_date
    FROM students s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN logbook_entries le ON le.student_id = s.id
    WHERE s.status = 'Aktif'
      AND NOT EXISTS (
        SELECT 1
        FROM logbook_entries today_log
        WHERE today_log.student_id = s.id
          AND today_log.date = $1::date
      )
    GROUP BY s.id, s.user_id, u.name
    HAVING ($1::date - COALESCE(MAX(le.date), DATE '1970-01-01')) >= $2::int
    `,
    [referenceDate, thresholdDays]
  );

  let sent = 0;
  let skipped = 0;

  for (const student of studentsResult.rows) {
    for (const operator of operatorsResult.rows) {
      const referenceKey = `${student.student_id}:${referenceDate}:logbook_missing`;
      const alreadyDispatched = await hasNotificationDispatch({
        eventId: "logbook_missing",
        recipientUserId: operator.id,
        referenceKey,
        scheduleSlot: slot
      });

      if (alreadyDispatched) {
        skipped += 1;
        continue;
      }

      const result = await createNotification({
        recipientUserId: operator.id,
        senderUserId: null,
        type: "pengumuman",
        eventId: "logbook_missing",
        reminderType: "logbook_missing",
        title: "Reminder Logbook Belum Diisi",
        body: `${student.student_name} belum mengisi logbook untuk tanggal ${referenceDate}.`
      });

      if (result.sent) {
        await recordNotificationDispatch({
          eventId: "logbook_missing",
          recipientUserId: operator.id,
          referenceKey,
          scheduleSlot: slot,
          notificationId: result.id,
          payload: { studentId: student.student_id, referenceDate }
        });

        await recordDashboardReminder({
          recipientUserId: operator.id,
          studentId: student.student_id,
          type: "logbook_missing",
          referenceDate,
          notificationId: result.id,
          sentBy: null
        });

        sent += 1;
      } else {
        skipped += 1;
      }
    }
  }

  return { sent, skipped };
}

async function dispatchOperatorLowAttendance({ slot, referencePeriod }) {
  if (slot !== "deadline") {
    return { sent: 0, skipped: 0 };
  }

  const operatorsResult = await query("SELECT id FROM users WHERE role = 'operator' AND is_active = TRUE");
  if (operatorsResult.rowCount === 0) return { sent: 0, skipped: 0 };

  const lowHoursResult = await query(
    `
    SELECT s.id AS student_id, s.user_id AS recipient_user_id, u.name AS student_name,
           COALESCE(s.jam_minggu_ini, 0) AS current_hours,
           COALESCE(s.jam_minggu_target, 0) AS target_hours
    FROM students s
    JOIN users u ON u.id = s.user_id
    WHERE s.status = 'Aktif'
      AND COALESCE(s.jam_minggu_target, 0) > 0
      AND COALESCE(s.jam_minggu_ini, 0) < COALESCE(s.jam_minggu_target, 0)
    `
  );

  let sent = 0;
  let skipped = 0;

  for (const student of lowHoursResult.rows) {
    for (const operator of operatorsResult.rows) {
      const referenceKey = `${student.student_id}:${referencePeriod}:low_hours`;
      const alreadyDispatched = await hasNotificationDispatch({
        eventId: "low_attendance",
        recipientUserId: operator.id,
        referenceKey,
        scheduleSlot: slot
      });

      if (alreadyDispatched) {
        skipped += 1;
        continue;
      }

      const result = await createNotification({
        recipientUserId: operator.id,
        senderUserId: null,
        type: "pengumuman",
        eventId: "low_attendance",
        reminderType: "low_hours",
        title: "Reminder Jam Tidak Terpenuhi",
        body: `${student.student_name} baru memenuhi ${student.current_hours}/${student.target_hours} jam pada periode ${referencePeriod}.`
      });

      if (result.sent) {
        await recordNotificationDispatch({
          eventId: "low_attendance",
          recipientUserId: operator.id,
          referenceKey,
          scheduleSlot: slot,
          notificationId: result.id,
          payload: { studentId: student.student_id, referencePeriod, warningType: "low_hours" }
        });

        await recordDashboardReminder({
          recipientUserId: operator.id,
          studentId: student.student_id,
          type: "low_hours",
          referencePeriod,
          notificationId: result.id,
          sentBy: null
        });

        sent += 1;
      } else {
        skipped += 1;
      }
    }
  }

  return { sent, skipped };
}

async function runReminderCycle(now = new Date()) {
  const reminderSettings = await getNotificationReminderSettings();
  const nowParts = getJakartaNowParts(now);
  const dueSlots = resolveDueSlots(reminderSettings, nowParts);

  if (dueSlots.length === 0) {
    return {
      ran: false,
      reason: "no_due_slot",
      now: nowParts
    };
  }

  const summary = [];
  for (const slot of dueSlots) {
    const logbookReminder = await dispatchLogbookReminderForSlot({
      slot,
      referenceDate: nowParts.date
    });
    const operatorMissing = await dispatchOperatorLogbookMissing({
      slot,
      referenceDate: nowParts.date,
      toleranceDays: reminderSettings?.toleranceDays
    });
    const operatorLowAttendance = await dispatchOperatorLowAttendance({
      slot,
      referencePeriod: getIsoWeekKey(now)
    });

    summary.push({
      slot,
      logbookReminder,
      operatorMissing,
      operatorLowAttendance
    });
  }

  return {
    ran: true,
    now: nowParts,
    summary
  };
}

async function runSchedulerTick() {
  try {
    const result = await runReminderCycle();
    if (result.ran) {
      console.log("[NotifScheduler] Reminder cycle executed:", JSON.stringify(result));
    }
    return result;
  } catch (error) {
    console.error("[NotifScheduler] Reminder cycle failed:", error.message);
    return {
      ran: false,
      reason: "error",
      error: error.message
    };
  }
}

function startMonitoring() {
  console.log("[NotifScheduler] Starting notification reminder scheduler (checks every minute)...");
  runSchedulerTick().catch(() => {});
  setInterval(() => {
    runSchedulerTick().catch(() => {});
  }, ONE_MINUTE);
}

module.exports = {
  getJakartaNowParts,
  resolveDueSlots,
  runReminderCycle,
  runSchedulerTick,
  startMonitoring
};

if (require.main === module) {
  runSchedulerTick()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
