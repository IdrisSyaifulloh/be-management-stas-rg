const crypto = require("crypto");
const { query } = require("../db/pool");

const DASHBOARD_REMINDER_TYPES = ["logbook_missing", "attendance_absent", "low_hours"];
const DASHBOARD_REMINDER_TYPE_SET = new Set(DASHBOARD_REMINDER_TYPES);

let ensureDashboardReminderTablePromise = null;

async function ensureDashboardReminderTable() {
  if (!ensureDashboardReminderTablePromise) {
    ensureDashboardReminderTablePromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS dashboard_reminder_logs (
          id TEXT PRIMARY KEY,
          recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          type TEXT NOT NULL CHECK (type IN ('logbook_missing', 'attendance_absent', 'low_hours')),
          reference_date DATE,
          reference_period TEXT,
          notification_id TEXT,
          sent_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS idx_dashboard_reminders_student_date
        ON dashboard_reminder_logs(student_id, type, reference_date, sent_at DESC)
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS idx_dashboard_reminders_student_period
        ON dashboard_reminder_logs(student_id, type, reference_period, sent_at DESC)
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS idx_dashboard_reminders_recipient_sent
        ON dashboard_reminder_logs(recipient_user_id, sent_at DESC)
      `);
    })();
  }

  await ensureDashboardReminderTablePromise;
}

function normalizeDashboardReminderType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");

  if (!normalized) return null;
  if (DASHBOARD_REMINDER_TYPE_SET.has(normalized)) return normalized;

  const aliases = {
    belum_isi_logbook: "logbook_missing",
    logbook: "logbook_missing",
    logbookmissing: "logbook_missing",
    attendance: "attendance_absent",
    absent: "attendance_absent",
    tidak_hadir: "attendance_absent",
    kehadiran_absen: "attendance_absent",
    lowhours: "low_hours",
    jam_tidak_terpenuhi: "low_hours",
    jam_kurang: "low_hours"
  };

  return aliases[normalized] || null;
}

function inferDashboardReminderType({ reminderType, type, title, body }) {
  const directType = normalizeDashboardReminderType(reminderType || type);
  if (directType) return directType;

  const haystack = `${title || ""} ${body || ""}`.toLowerCase();
  if (!haystack.trim()) return null;

  if (haystack.includes("logbook") && (haystack.includes("belum") || haystack.includes("missing"))) {
    return "logbook_missing";
  }
  if (
    haystack.includes("tidak hadir") ||
    haystack.includes("attendance absent") ||
    haystack.includes("absen hari ini")
  ) {
    return "attendance_absent";
  }
  if (
    haystack.includes("jam tidak terpenuhi") ||
    haystack.includes("low hours") ||
    haystack.includes("jam kurang")
  ) {
    return "low_hours";
  }

  return null;
}

function normalizeReferenceDate(value) {
  if (!value) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value.trim();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getIsoWeekKey(date = new Date()) {
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);

  const dayNumber = (target.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNumber + 3);

  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const firstThursdayDay = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstThursdayDay + 3);

  const weekNumber = 1 + Math.round((target.getTime() - firstThursday.getTime()) / 604800000);
  return `${target.getFullYear()}-W${String(weekNumber).padStart(2, "0")}`;
}

function buildReminderIdentity({ type, referenceDate, referencePeriod }) {
  if (!type) return { referenceDate: null, referencePeriod: null };

  if (type === "low_hours") {
    return {
      referenceDate: null,
      referencePeriod: String(referencePeriod || getIsoWeekKey()).trim()
    };
  }

  return {
    referenceDate: normalizeReferenceDate(referenceDate) || normalizeReferenceDate(new Date()),
    referencePeriod: null
  };
}

async function resolveDashboardReminderStudentId({ studentId, recipientUserId }) {
  if (studentId) {
    const byStudentId = await query("SELECT id FROM students WHERE id = $1 LIMIT 1", [studentId]);
    if (byStudentId.rowCount > 0) return byStudentId.rows[0].id;

    const byUserId = await query("SELECT id FROM students WHERE user_id = $1 LIMIT 1", [studentId]);
    if (byUserId.rowCount > 0) return byUserId.rows[0].id;
  }

  if (!recipientUserId) return null;

  const result = await query("SELECT id FROM students WHERE user_id = $1 LIMIT 1", [recipientUserId]);
  return result.rowCount > 0 ? result.rows[0].id : null;
}

async function findExistingDashboardReminder({ studentId, type, referenceDate, referencePeriod }) {
  await ensureDashboardReminderTable();

  if (!studentId || !type) return null;

  if (type === "low_hours") {
    const result = await query(
      `
      SELECT id, notification_id, sent_at
      FROM dashboard_reminder_logs
      WHERE student_id = $1
        AND type = $2
        AND reference_period = $3
      ORDER BY sent_at DESC, id DESC
      LIMIT 1
      `,
      [studentId, type, referencePeriod]
    );

    return result.rows[0] || null;
  }

  const result = await query(
    `
    SELECT id, notification_id, sent_at
    FROM dashboard_reminder_logs
    WHERE student_id = $1
      AND type = $2
      AND reference_date = $3
    ORDER BY sent_at DESC, id DESC
    LIMIT 1
    `,
    [studentId, type, referenceDate]
  );

  return result.rows[0] || null;
}

async function recordDashboardReminder({
  recipientUserId,
  studentId,
  type,
  referenceDate,
  referencePeriod,
  notificationId,
  sentBy
}) {
  await ensureDashboardReminderTable();

  const reminderId = `RMD-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const identity = buildReminderIdentity({ type, referenceDate, referencePeriod });

  await query(
    `
    INSERT INTO dashboard_reminder_logs (
      id,
      recipient_user_id,
      student_id,
      type,
      reference_date,
      reference_period,
      notification_id,
      sent_by
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      reminderId,
      recipientUserId,
      studentId,
      type,
      identity.referenceDate,
      identity.referencePeriod,
      notificationId || null,
      sentBy || null
    ]
  );

  return {
    id: reminderId,
    ...identity
  };
}

module.exports = {
  DASHBOARD_REMINDER_TYPES,
  buildReminderIdentity,
  ensureDashboardReminderTable,
  findExistingDashboardReminder,
  getIsoWeekKey,
  inferDashboardReminderType,
  normalizeDashboardReminderType,
  normalizeReferenceDate,
  recordDashboardReminder,
  resolveDashboardReminderStudentId
};
