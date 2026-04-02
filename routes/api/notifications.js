const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { clampLimit } = require("../../utils/queryFilters");
const { extractRole } = require("../../utils/roleGuard");

const router = express.Router();

let notificationsTableReady = false;
async function ensureNotificationsTable() {
  if (notificationsTableReady) return;

  await query(
    `
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
    `
  );

  await query(
    `
    CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created
    ON notifications(recipient_user_id, created_at DESC)
    `
  );

  notificationsTableReady = true;
}

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

    const params = [resolvedUserId];
    let where = "WHERE n.recipient_user_id = $1";

    if (String(unreadOnly).toLowerCase() === "true") {
      where += " AND n.read_at IS NULL";
    }

    params.push(clampLimit(limit, 50, 200));

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

    res.json(result.rows);
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    await ensureNotificationsTable();

    const { id, recipientUserId, type = "pengumuman", title, body } = req.body || {};
    const requesterRole = extractRole(req);
    if (!["operator", "dosen"].includes(requesterRole)) {
      return res.status(403).json({ message: "Hanya operator/dosen yang dapat mengirim notifikasi manual." });
    }

    if (!recipientUserId || !title || !body) {
      return res.status(400).json({ message: "recipientUserId, title, body wajib diisi." });
    }

    const resolvedRecipient = await resolveRecipientUserId(recipientUserId);
    if (!resolvedRecipient) {
      return res.status(404).json({ message: "Penerima notifikasi tidak ditemukan." });
    }

    const notificationId = id || `NTF-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    await query(
      `
      INSERT INTO notifications (id, recipient_user_id, sender_user_id, type, title, body)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [notificationId, resolvedRecipient, resolveRequesterUserId(req) || null, type, title, body]
    );

    res.status(201).json({ message: "Notifikasi berhasil dikirim.", id: notificationId });
  })
);

router.patch(
  "/:id/read/all",
  asyncHandler(async (req, res) => {
    await ensureNotificationsTable();

    const requesterRole = extractRole(req);
    const requesterUserId = resolveRequesterUserId(req);
    const userId = requesterRole === "operator" ? (req.body?.userId || requesterUserId) : requesterUserId;
    const params = [req.params.id];
    let where = "id = $1";

    if (userId) {
      params.push(userId);
      where += ` AND recipient_user_id = $${params.length}`;
    }

    const result = await query(
      `
      UPDATE notifications
      SET read_at = NOW()
      WHERE ${where}
      RETURNING id
      `,
      params
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Notifikasi tidak ditemukan." });
    }

    res.json({ message: "Notifikasi ditandai sudah dibaca." });
  })
);

router.patch(
  "/read",
  asyncHandler(async (req, res) => {
    await ensureNotificationsTable();

    const requesterRole = extractRole(req);
    const { userId: bodyUserId } = req.body || {};
    const requesterUserId = resolveRequesterUserId(req);
    const userId = requesterRole === "operator" ? (bodyUserId || requesterUserId) : requesterUserId;
    if (!userId) {
      return res.status(400).json({ message: "userId wajib diisi." });
    }

    await query(
      `
      UPDATE notifications
      SET read_at = NOW()
      WHERE recipient_user_id = $1 AND read_at IS NULL
      `,
      [userId]
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
