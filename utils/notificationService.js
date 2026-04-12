const { query } = require("../db/pool");
const { getSettingsAsync, DEFAULT_SETTINGS } = require("../config/systemSettingsStore");

let notificationsTableReady = false;
let notificationDispatchTableReady = false;

const EVENT_LABELS = new Map(
  ((DEFAULT_SETTINGS.notif || {}).events || []).map((item) => [item.id, item.label])
);

async function ensureNotificationsTable() {
  if (notificationsTableReady) return;

  await query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      type TEXT NOT NULL DEFAULT 'pengumuman',
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created
    ON notifications(recipient_user_id, created_at DESC)
  `);

  notificationsTableReady = true;
}

async function ensureNotificationDispatchTable() {
  if (notificationDispatchTableReady) return;

  await query(`
    CREATE TABLE IF NOT EXISTS notification_dispatch_logs (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reference_key TEXT NOT NULL,
      schedule_slot TEXT,
      notification_id TEXT,
      payload JSONB,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (event_id, recipient_user_id, reference_key, schedule_slot)
    )
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS idx_notification_dispatch_event_recipient
    ON notification_dispatch_logs(event_id, recipient_user_id, sent_at DESC)
  `);

  notificationDispatchTableReady = true;
}

function normalizeEventId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

async function getNotificationSettings() {
  const settings = await getSettingsAsync();
  return settings?.notif || DEFAULT_SETTINGS.notif;
}

async function getNotificationReminderSettings() {
  const notif = await getNotificationSettings();
  return {
    ...((DEFAULT_SETTINGS.notif || {}).reminder || {}),
    ...((notif || {}).reminder || {})
  };
}

async function isNotificationEventEnabled(eventId) {
  const normalizedId = normalizeEventId(eventId);
  if (!normalizedId) return true;

  const notif = await getNotificationSettings();
  const events = Array.isArray(notif?.events) ? notif.events : [];
  const configuredEvent = events.find((item) => normalizeEventId(item?.id) === normalizedId);
  if (!configuredEvent) return true;
  return configuredEvent.enabled !== false;
}

function inferNotificationEventId({ eventId, reminderType, type, title, body }) {
  const explicit = normalizeEventId(eventId);
  if (explicit) return explicit;

  const normalizedReminderType = normalizeEventId(reminderType);
  if (normalizedReminderType === "logbook_missing") return "logbook_missing";
  if (normalizedReminderType === "logbook_reminder") return "logbook_reminder";
  if (["attendance_absent", "low_hours", "low_attendance"].includes(normalizedReminderType)) {
    return "low_attendance";
  }

  const normalizedType = normalizeEventId(type);
  if (normalizedType === "cuti" || normalizedType === "cuti_request") return "cuti_request";
  if (normalizedType === "surat" || normalizedType === "surat_request") return "surat_request";
  if (normalizedType === "milestone" || normalizedType === "milestone_update") return "milestone_update";

  const haystack = `${title || ""} ${body || ""}`.toLowerCase();
  if (!haystack.trim()) return null;

  if (haystack.includes("milestone")) return "milestone_update";
  if (haystack.includes("pengajuan cuti") || haystack.includes("status cuti")) return "cuti_request";
  if (haystack.includes("pengajuan surat") || haystack.includes("status surat") || haystack.includes("permintaan surat")) {
    return "surat_request";
  }
  if (haystack.includes("reminder logbook") || haystack.includes("pengingat logbook")) return "logbook_reminder";
  if (haystack.includes("logbook") && (haystack.includes("belum") || haystack.includes("missing"))) {
    return "logbook_missing";
  }
  if (
    haystack.includes("tidak hadir") ||
    haystack.includes("kehadiran rendah") ||
    haystack.includes("jam tidak terpenuhi") ||
    haystack.includes("low hours")
  ) {
    return "low_attendance";
  }

  return null;
}

async function createNotification({
  id,
  recipientUserId,
  senderUserId = null,
  type = "pengumuman",
  title,
  body,
  eventId = null,
  reminderType = null
}) {
  if (!recipientUserId || !title || !body) {
    const error = new Error("recipientUserId, title, body wajib diisi.");
    error.statusCode = 400;
    throw error;
  }

  await ensureNotificationsTable();

  const resolvedEventId = inferNotificationEventId({ eventId, reminderType, type, title, body });
  const enabled = await isNotificationEventEnabled(resolvedEventId);
  if (!enabled) {
    return {
      sent: false,
      skipped: true,
      reason: "event_disabled",
      eventId: resolvedEventId,
      eventLabel: EVENT_LABELS.get(resolvedEventId) || resolvedEventId || null,
      message: `Notifikasi dilewati karena event ${resolvedEventId} sedang nonaktif.`
    };
  }

  const notificationId = id || `NTF-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  await query(
    `
    INSERT INTO notifications (id, recipient_user_id, sender_user_id, type, title, body)
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [notificationId, recipientUserId, senderUserId, type, title, body]
  );

  return {
    sent: true,
    skipped: false,
    id: notificationId,
    eventId: resolvedEventId
  };
}

async function hasNotificationDispatch({ eventId, recipientUserId, referenceKey, scheduleSlot = null }) {
  await ensureNotificationDispatchTable();
  const result = await query(
    `
    SELECT id
    FROM notification_dispatch_logs
    WHERE event_id = $1
      AND recipient_user_id = $2
      AND reference_key = $3
      AND (
        ($4::text IS NULL AND schedule_slot IS NULL)
        OR schedule_slot = $4
      )
    LIMIT 1
    `,
    [eventId, recipientUserId, referenceKey, scheduleSlot]
  );

  return result.rowCount > 0;
}

async function recordNotificationDispatch({
  eventId,
  recipientUserId,
  referenceKey,
  scheduleSlot = null,
  notificationId = null,
  payload = null
}) {
  await ensureNotificationDispatchTable();
  const dispatchId = `NDL-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  await query(
    `
    INSERT INTO notification_dispatch_logs (
      id, event_id, recipient_user_id, reference_key, schedule_slot, notification_id, payload
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    ON CONFLICT (event_id, recipient_user_id, reference_key, schedule_slot) DO NOTHING
    `,
    [dispatchId, eventId, recipientUserId, referenceKey, scheduleSlot, notificationId, JSON.stringify(payload || {})]
  );
}

module.exports = {
  createNotification,
  ensureNotificationDispatchTable,
  ensureNotificationsTable,
  getNotificationReminderSettings,
  getNotificationSettings,
  hasNotificationDispatch,
  inferNotificationEventId,
  isNotificationEventEnabled,
  normalizeEventId,
  recordNotificationDispatch
};
