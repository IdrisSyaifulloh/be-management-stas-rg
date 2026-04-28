const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { parseBoundedLimit, requireSafeId } = require("../../utils/securityValidation");
const { extractRole } = require("../../utils/roleGuard");
const { createNotification, ensureNotificationsTable, inferNotificationEventId } = require("../../utils/notificationService");
const {
  buildReminderIdentity,
  findExistingDashboardReminder,
  inferDashboardReminderType,
  recordDashboardReminder,
  resolveDashboardReminderStudentId
} = require("../../utils/dashboardReminders");

const router = express.Router();

let appSettingsTableReady = false;
async function ensureAppSettingsTable() {
  if (appSettingsTableReady) return;
  await query(
    `
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    `
  );
  appSettingsTableReady = true;
}

function resolveRequesterUserId(req) {
  return String(req.headers["x-user-id"] || req.query.userId || req.body?.userId || req.authUser?.id || "").trim();
}

async function resolveRecipientUserId(inputId) {
  const direct = await query("SELECT id FROM users WHERE id = $1 LIMIT 1", [inputId]);
  if (direct.rowCount > 0) return direct.rows[0].id;

  const fromStudent = await query("SELECT user_id FROM students WHERE id = $1 LIMIT 1", [inputId]);
  if (fromStudent.rowCount > 0) return fromStudent.rows[0].user_id;

  return null;
}

function mapNotificationRow(row) {
  return {
    ...row,
    readAt: row.read_at || null,
    createdAt: row.created_at || null,
    recipientUserId: row.recipient_user_id,
    senderUserId: row.sender_user_id,
    senderName: row.sender_name || null,
    read: row.read_at != null
  };
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    await ensureNotificationsTable();

    const { userId, unreadOnly = "false", limit = 50 } = req.query;
    const requesterRole = extractRole(req);
    const requesterUserId = resolveRequesterUserId(req);
    const resolvedUserId = requesterRole === "operator" ? String(userId || requesterUserId || "") : requesterUserId;

    if (!resolvedUserId) {
      return res.status(400).json({ message: "userId wajib diisi." });
    }

    requireSafeId(resolvedUserId, "userId");
    const normalizedUnreadOnly = String(unreadOnly).toLowerCase();
    if (!["true", "false"].includes(normalizedUnreadOnly)) {
      return res.status(400).json({ message: "Input tidak valid." });
    }

    const params = [resolvedUserId];
    let where = "WHERE n.recipient_user_id = $1";

    if (normalizedUnreadOnly === "true") {
      where += " AND n.read_at IS NULL";
    }

    params.push(parseBoundedLimit(limit, 50, 200));

    const result = await query(
      `
      SELECT n.id, n.recipient_user_id, n.sender_user_id, n.type, n.title, n.body, n.read_at, n.created_at,
             su.name AS sender_name
      FROM notifications n
      LEFT JOIN users su ON su.id = n.sender_user_id
      ${where}
      ORDER BY n.created_at DESC
      LIMIT $${params.length}
      `,
      params
    );

    res.json(result.rows.map(mapNotificationRow));
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    await ensureNotificationsTable();

    const {
      id,
      recipientUserId,
      type = "pengumuman",
      title,
      body,
      eventId,
      reminderType,
      studentId,
      referenceDate,
      referencePeriod,
      forceResend = false
    } = req.body || {};
    const requesterRole = extractRole(req);
    if (!["operator", "dosen"].includes(requesterRole)) {
      return res.status(403).json({ message: "Hanya operator/dosen yang dapat mengirim notifikasi manual." });
    }

    if (!recipientUserId || !title || !body) {
      return res.status(400).json({ message: "recipientUserId, title, body wajib diisi." });
    }
    requireSafeId(recipientUserId, "recipientUserId");

    const resolvedRecipient = await resolveRecipientUserId(recipientUserId);
    if (!resolvedRecipient) {
      return res.status(404).json({ message: "Penerima notifikasi tidak ditemukan." });
    }

    const detectedReminderType = inferDashboardReminderType({ reminderType, type, title, body });
    const inferredEventId = inferNotificationEventId({ eventId, reminderType: detectedReminderType || reminderType, type, title, body });
    const resolvedStudentId = detectedReminderType
      ? await resolveDashboardReminderStudentId({ studentId, recipientUserId: resolvedRecipient })
      : null;
    const reminderIdentity = detectedReminderType
      ? buildReminderIdentity({
          type: detectedReminderType,
          referenceDate,
          referencePeriod
        })
      : null;

    if (detectedReminderType === "attendance_absent") {
      return res.status(200).json({
        message: "Notifikasi untuk section Tidak Hadir Hari Ini sudah dinonaktifkan.",
        skipped: true,
        reason: "attendance_absent_notification_removed",
        eventId: inferredEventId || "low_attendance"
      });
    }

    if (detectedReminderType && resolvedStudentId && !Boolean(forceResend)) {
      const existingReminder = await findExistingDashboardReminder({
        studentId: resolvedStudentId,
        type: detectedReminderType,
        referenceDate: reminderIdentity.referenceDate,
        referencePeriod: reminderIdentity.referencePeriod
      });

      if (existingReminder) {
        return res.status(200).json({
          message: "Reminder dashboard untuk rule dan periode ini sudah pernah dikirim.",
          id: existingReminder.notification_id || existingReminder.id,
          duplicate: true,
          reminder: {
            type: detectedReminderType,
            referenceDate: reminderIdentity.referenceDate,
            referencePeriod: reminderIdentity.referencePeriod,
            sentAt: existingReminder.sent_at
          }
        });
      }
    }

    const senderUserId = resolveRequesterUserId(req) || null;
    const notificationResult = await createNotification({
      id,
      recipientUserId: resolvedRecipient,
      senderUserId,
      type,
      title,
      body,
      eventId: inferredEventId,
      reminderType: detectedReminderType || reminderType
    });

    if (notificationResult.skipped) {
      return res.status(200).json({
        message: notificationResult.message,
        skipped: true,
        reason: notificationResult.reason,
        eventId: notificationResult.eventId
      });
    }

    if (detectedReminderType && resolvedStudentId && notificationResult.id) {
      await recordDashboardReminder({
        recipientUserId: resolvedRecipient,
        studentId: resolvedStudentId,
        type: detectedReminderType,
        referenceDate: reminderIdentity.referenceDate,
        referencePeriod: reminderIdentity.referencePeriod,
        notificationId: notificationResult.id,
        sentBy: senderUserId
      });
    }

    res.status(201).json({
      message: "Notifikasi berhasil dikirim.",
      id: notificationResult.id,
      reminder: detectedReminderType && resolvedStudentId
        ? {
            type: detectedReminderType,
            referenceDate: reminderIdentity.referenceDate,
            referencePeriod: reminderIdentity.referencePeriod
          }
        : null
    });
  })
);

router.patch(
  "/read-all",
  asyncHandler(async (req, res) => {
    await ensureNotificationsTable();

    const requesterUserId = resolveRequesterUserId(req);
    if (!requesterUserId) {
      return res.status(400).json({ message: "userId wajib diisi." });
    }
    requireSafeId(requesterUserId, "userId");

    const result = await query(
      `
      UPDATE notifications
      SET read_at = NOW()
      WHERE recipient_user_id = $1
        AND read_at IS NULL
      RETURNING id
      `,
      [requesterUserId]
    );

    res.json({
      message: "Semua notifikasi ditandai sudah dibaca.",
      updatedCount: result.rowCount
    });
  })
);

router.patch(
  "/:id/read",
  asyncHandler(async (req, res) => {
    await ensureNotificationsTable();

    const requesterUserId = resolveRequesterUserId(req);
    if (!requesterUserId) {
      return res.status(400).json({ message: "userId wajib diisi." });
    }
    requireSafeId(req.params.id, "id");
    requireSafeId(requesterUserId, "userId");

    const result = await query(
      `
      UPDATE notifications
      SET read_at = COALESCE(read_at, NOW())
      WHERE id = $1
        AND recipient_user_id = $2
      RETURNING id, read_at
      `,
      [req.params.id, requesterUserId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Notifikasi tidak ditemukan." });
    }

    res.json({
      message: "Notifikasi ditandai sudah dibaca.",
      id: result.rows[0].id,
      read_at: result.rows[0].read_at,
      readAt: result.rows[0].read_at,
      read: true
    });
  })
);

router.patch(
  "/:id/read/all",
  asyncHandler(async (req, res) => {
    await ensureNotificationsTable();

    const requesterUserId = resolveRequesterUserId(req);
    if (!requesterUserId) {
      return res.status(400).json({ message: "userId wajib diisi." });
    }
    requireSafeId(req.params.id, "id");
    requireSafeId(requesterUserId, "userId");

    const result = await query(
      `
      UPDATE notifications
      SET read_at = COALESCE(read_at, NOW())
      WHERE id = $1
        AND recipient_user_id = $2
      RETURNING id, read_at
      `,
      [req.params.id, requesterUserId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Notifikasi tidak ditemukan." });
    }

    res.json({
      message: "Notifikasi ditandai sudah dibaca.",
      id: result.rows[0].id,
      read_at: result.rows[0].read_at,
      readAt: result.rows[0].read_at,
      read: true
    });
  })
);

router.patch(
  "/read",
  asyncHandler(async (req, res) => {
    await ensureNotificationsTable();

    const requesterUserId = resolveRequesterUserId(req);
    if (!requesterUserId) {
      return res.status(400).json({ message: "userId wajib diisi." });
    }
    requireSafeId(requesterUserId, "userId");

    await query(
      `
      UPDATE notifications
      SET read_at = NOW()
      WHERE recipient_user_id = $1 AND read_at IS NULL
      `,
      [requesterUserId]
    );

    res.json({ message: "Semua notifikasi ditandai sudah dibaca." });
  })
);

router.get(
  "/preferences",
  asyncHandler(async (req, res) => {
    await ensureAppSettingsTable();

    const userId = resolveRequesterUserId(req);
    if (!userId) {
      return res.status(400).json({ message: "userId wajib diisi." });
    }
    requireSafeId(userId, "userId");

    const settingKey = `notification_prefs:${userId}`;
    const result = await query(
      "SELECT setting_value FROM app_settings WHERE setting_key = $1 LIMIT 1",
      [settingKey]
    );

    res.json(result.rowCount > 0 ? result.rows[0].setting_value : { items: [] });
  })
);

router.put(
  "/preferences",
  asyncHandler(async (req, res) => {
    await ensureAppSettingsTable();

    const userId = resolveRequesterUserId(req);
    const { items } = req.body || {};

    if (!userId) {
      return res.status(400).json({ message: "userId wajib diisi." });
    }
    requireSafeId(userId, "userId");
    if (!Array.isArray(items)) {
      return res.status(400).json({ message: "items wajib berupa array." });
    }

    const sanitizedItems = items
      .map((item) => ({
        id: String(item?.id || "").trim(),
        enabled: Boolean(item?.enabled)
      }))
      .filter((item) => item.id);

    const settingKey = `notification_prefs:${userId}`;
    await query(
      `
      INSERT INTO app_settings (setting_key, setting_value, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (setting_key)
      DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()
      `,
      [settingKey, JSON.stringify({ items: sanitizedItems })]
    );

    res.json({ message: "Preferensi notifikasi berhasil disimpan." });
  })
);

module.exports = router;
