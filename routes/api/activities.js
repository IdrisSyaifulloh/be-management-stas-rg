const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { extractRole } = require("../../utils/roleGuard");
const { requireSafeId } = require("../../utils/securityValidation");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();

const ACTIVITIES_UPLOAD_DIR = path.join(__dirname, "../../public/uploads/activities");

const ALLOWED_PHOTO_TYPES = {
  "image/png": ".png",
  "image/jpeg": ".jpg"
};

const ALLOWED_DOC_TYPES = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx"
};

const VALID_ACTIVITY_FORMS = ["meeting", "visit_internal", "visit_external", "lab_test", "lab", "visit", "other"];

function sanitizeFilenameBase(name) {
  return String(name || "activity")
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "activity";
}

async function saveActivityFile(fileDataUrl, originalFileName, allowedTypes, maxSizeMb = 5) {
  const match = String(fileDataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    const error = new Error("Format file tidak valid. Gunakan data URL base64.");
    error.statusCode = 400;
    throw error;
  }

  const mimeType = match[1];
  const base64Payload = match[2];
  const extension = allowedTypes[mimeType];
  if (!extension) {
    const allowed = Object.keys(allowedTypes).join(", ");
    const error = new Error(`Tipe file tidak didukung. Tipe yang diizinkan: ${allowed}`);
    error.statusCode = 400;
    throw error;
  }

  let buffer;
  try {
    buffer = Buffer.from(base64Payload, "base64");
  } catch {
    const error = new Error("File base64 tidak valid.");
    error.statusCode = 400;
    throw error;
  }

  if (!buffer || buffer.length === 0) {
    const error = new Error("File kosong tidak dapat diunggah.");
    error.statusCode = 400;
    throw error;
  }

  const maxBytes = maxSizeMb * 1024 * 1024;
  if (buffer.length > maxBytes) {
    const error = new Error(`Ukuran file maksimal ${maxSizeMb} MB.`);
    error.statusCode = 400;
    throw error;
  }

  await fs.mkdir(ACTIVITIES_UPLOAD_DIR, { recursive: true });
  const cleanBaseName = sanitizeFilenameBase(originalFileName);
  const finalName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${cleanBaseName}${extension}`;
  await fs.writeFile(path.join(ACTIVITIES_UPLOAD_DIR, finalName), buffer);
  return `/uploads/activities/${finalName}`;
}

let ensureTablePromise = null;

async function ensureActivitiesTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS stas_activities (
          id TEXT PRIMARY KEY,
          activity_date DATE NOT NULL,
          activity_type TEXT NOT NULL CHECK (activity_type IN ('riset', 'abdimas', 'internal')),
          activity_form TEXT NOT NULL,
          activity_name TEXT NOT NULL,
          agenda TEXT,
          goal TEXT,
          description_summary TEXT,
          activity_time TIME,
          location TEXT,
          participants_count INTEGER,
          participants_list TEXT,
          output TEXT,
          folder_bergkas_url TEXT,
          photo_url TEXT,
          notulensi_url TEXT,
          notulensi_name TEXT,
          surat_url TEXT,
          surat_name TEXT,
          pic_name TEXT,
          input_by TEXT NOT NULL REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_stas_activities_date ON stas_activities(activity_date DESC);
        CREATE INDEX IF NOT EXISTS idx_stas_activities_type ON stas_activities(activity_type);
        CREATE INDEX IF NOT EXISTS idx_stas_activities_input_by ON stas_activities(input_by);
      `);

      // Add new columns if upgrading from old schema
      await query(`
        ALTER TABLE stas_activities
          ADD COLUMN IF NOT EXISTS participants_count INTEGER,
          ADD COLUMN IF NOT EXISTS notulensi_url TEXT,
          ADD COLUMN IF NOT EXISTS notulensi_name TEXT,
          ADD COLUMN IF NOT EXISTS surat_url TEXT,
          ADD COLUMN IF NOT EXISTS surat_name TEXT,
          ADD COLUMN IF NOT EXISTS pic_name TEXT
      `);

      // Migrate activity_form constraint to include new values
      await query(`
        ALTER TABLE stas_activities
          DROP CONSTRAINT IF EXISTS stas_activities_activity_form_check
      `);
    })();
  }

  await ensureTablePromise;
}

const SELECT_FIELDS = `
  id,
  activity_date,
  activity_type,
  activity_form,
  activity_name,
  agenda,
  goal,
  description_summary,
  activity_time,
  location,
  participants_count,
  participants_list,
  output,
  folder_bergkas_url,
  photo_url,
  notulensi_url,
  notulensi_name,
  surat_url,
  surat_name,
  pic_name,
  input_by,
  created_at,
  updated_at
`;

/**
 * GET /api/activities
 * List all activities (operator only)
 * Query params: startDate, endDate, type (riset|abdimas|internal)
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat mengakses." });
    }

    await ensureActivitiesTable();

    const { startDate, endDate, type } = req.query;
    const params = [];
    const where = [];

    if (startDate) {
      where.push(`activity_date >= $${params.length + 1}::date`);
      params.push(startDate);
    }

    if (endDate) {
      where.push(`activity_date <= $${params.length + 1}::date`);
      params.push(endDate);
    }

    if (type && ["riset", "abdimas", "internal"].includes(type)) {
      where.push(`activity_type = $${params.length + 1}`);
      params.push(type);
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const parsedLimit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const parsedOffset = Math.max(Number(req.query.offset) || 0, 0);
    params.push(parsedLimit);
    params.push(parsedOffset);

    const result = await query(
      `SELECT ${SELECT_FIELDS} FROM stas_activities ${whereClause} ORDER BY activity_date DESC, created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json(result.rows);
  })
);

/**
 * GET /api/activities/:id
 */
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat mengakses." });
    }

    const activityId = requireSafeId(req.params.id, "id");
    await ensureActivitiesTable();

    const result = await query(
      `SELECT ${SELECT_FIELDS} FROM stas_activities WHERE id = $1`,
      [activityId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Kegiatan tidak ditemukan." });
    }

    res.json(result.rows[0]);
  })
);

/**
 * POST /api/activities
 * Body fields:
 *   activityDate, activityType, activityForm, activityName, agenda, goal,
 *   descriptionSummary, activityTime, location, participantsCount, participantsList,
 *   output, folderBergkasUrl,
 *   photoDataUrl, photoFileName (image only, max 5 MB),
 *   notulensiDataUrl, notulensiFileName (PDF/DOC/image, max 10 MB),
 *   suratDataUrl, suratFileName (PDF/DOC/image, max 10 MB),
 *   picName
 */
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat membuat kegiatan." });
    }

    const userId = req.authUser?.id;
    if (!userId) {
      return res.status(401).json({ message: "Autentikasi diperlukan." });
    }

    const {
      activityDate,
      activityType,
      activityForm,
      activityName,
      agenda,
      goal,
      descriptionSummary,
      activityTime,
      location,
      participantsCount,
      participantsList,
      output,
      folderBergkasUrl,
      photoDataUrl,
      photoFileName,
      notulensiDataUrl,
      notulensiFileName,
      suratDataUrl,
      suratFileName,
      picName
    } = req.body || {};

    if (!activityDate || !activityType || !activityForm || !activityName) {
      return res.status(400).json({
        message: "Field wajib: activityDate, activityType, activityForm, activityName"
      });
    }

    if (!["riset", "abdimas", "internal"].includes(activityType)) {
      return res.status(400).json({ message: "activityType harus: riset, abdimas, atau internal." });
    }

    if (!VALID_ACTIVITY_FORMS.includes(activityForm)) {
      return res.status(400).json({ message: `activityForm harus salah satu: ${VALID_ACTIVITY_FORMS.join(", ")}` });
    }

    await ensureActivitiesTable();

    let photoUrl = null;
    if (photoDataUrl && typeof photoDataUrl === "string" && photoDataUrl.trim()) {
      try {
        photoUrl = await saveActivityFile(photoDataUrl.trim(), photoFileName || "foto", ALLOWED_PHOTO_TYPES, 5);
      } catch (error) {
        return res.status(error.statusCode || 400).json({ message: error.message });
      }
    }

    let notulensiUrl = null;
    if (notulensiDataUrl && typeof notulensiDataUrl === "string" && notulensiDataUrl.trim()) {
      try {
        notulensiUrl = await saveActivityFile(notulensiDataUrl.trim(), notulensiFileName || "notulensi", ALLOWED_DOC_TYPES, 10);
      } catch (error) {
        return res.status(error.statusCode || 400).json({ message: error.message });
      }
    }

    let suratUrl = null;
    if (suratDataUrl && typeof suratDataUrl === "string" && suratDataUrl.trim()) {
      try {
        suratUrl = await saveActivityFile(suratDataUrl.trim(), suratFileName || "surat", ALLOWED_DOC_TYPES, 10);
      } catch (error) {
        return res.status(error.statusCode || 400).json({ message: error.message });
      }
    }

    const activityId = `ACT-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

    await query(
      `
      INSERT INTO stas_activities (
        id, activity_date, activity_type, activity_form, activity_name,
        agenda, goal, description_summary, activity_time, location,
        participants_count, participants_list, output, folder_bergkas_url,
        photo_url, notulensi_url, notulensi_name, surat_url, surat_name, pic_name,
        input_by
      ) VALUES (
        $1, $2::date, $3, $4, $5,
        $6, $7, $8, $9::time, $10,
        $11, $12, $13, $14,
        $15, $16, $17, $18, $19, $20,
        $21
      )
      `,
      [
        activityId,
        activityDate,
        activityType,
        activityForm,
        activityName,
        agenda || null,
        goal || null,
        descriptionSummary || null,
        activityTime || null,
        location || null,
        participantsCount != null ? Number(participantsCount) : null,
        participantsList || null,
        output || null,
        folderBergkasUrl || null,
        photoUrl,
        notulensiUrl,
        notulensiFileName || null,
        suratUrl,
        suratFileName || null,
        picName || null,
        userId
      ]
    );

    res.status(201).json({
      message: "Kegiatan berhasil dibuat.",
      id: activityId,
      photoUrl,
      notulensiUrl,
      suratUrl
    });
  })
);

/**
 * PUT /api/activities/:id
 */
router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat mengubah kegiatan." });
    }

    const activityId = requireSafeId(req.params.id, "id");
    const userId = req.authUser?.id;
    if (!userId) {
      return res.status(401).json({ message: "Autentikasi diperlukan." });
    }

    await ensureActivitiesTable();

    const existing = await query(
      "SELECT id, photo_url, notulensi_url, notulensi_name, surat_url, surat_name FROM stas_activities WHERE id = $1",
      [activityId]
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ message: "Kegiatan tidak ditemukan." });
    }

    const existingRow = existing.rows[0];

    const {
      activityDate,
      activityType,
      activityForm,
      activityName,
      agenda,
      goal,
      descriptionSummary,
      activityTime,
      location,
      participantsCount,
      participantsList,
      output,
      folderBergkasUrl,
      photoDataUrl,
      photoFileName,
      notulensiDataUrl,
      notulensiFileName,
      suratDataUrl,
      suratFileName,
      picName
    } = req.body || {};

    if (activityType && !["riset", "abdimas", "internal"].includes(activityType)) {
      return res.status(400).json({ message: "activityType harus: riset, abdimas, atau internal." });
    }

    if (activityForm && !VALID_ACTIVITY_FORMS.includes(activityForm)) {
      return res.status(400).json({ message: `activityForm harus salah satu: ${VALID_ACTIVITY_FORMS.join(", ")}` });
    }

    let photoUrl = existingRow.photo_url;
    if (photoDataUrl && typeof photoDataUrl === "string" && photoDataUrl.trim()) {
      try {
        photoUrl = await saveActivityFile(photoDataUrl.trim(), photoFileName || "foto", ALLOWED_PHOTO_TYPES, 5);
      } catch (error) {
        return res.status(error.statusCode || 400).json({ message: error.message });
      }
    }

    let notulensiUrl = existingRow.notulensi_url;
    let resolvedNotulensiName = existingRow.notulensi_name;
    if (notulensiDataUrl && typeof notulensiDataUrl === "string" && notulensiDataUrl.trim()) {
      try {
        notulensiUrl = await saveActivityFile(notulensiDataUrl.trim(), notulensiFileName || "notulensi", ALLOWED_DOC_TYPES, 10);
        resolvedNotulensiName = notulensiFileName || resolvedNotulensiName;
      } catch (error) {
        return res.status(error.statusCode || 400).json({ message: error.message });
      }
    }

    let suratUrl = existingRow.surat_url;
    let resolvedSuratName = existingRow.surat_name;
    if (suratDataUrl && typeof suratDataUrl === "string" && suratDataUrl.trim()) {
      try {
        suratUrl = await saveActivityFile(suratDataUrl.trim(), suratFileName || "surat", ALLOWED_DOC_TYPES, 10);
        resolvedSuratName = suratFileName || resolvedSuratName;
      } catch (error) {
        return res.status(error.statusCode || 400).json({ message: error.message });
      }
    }

    await query(
      `
      UPDATE stas_activities
      SET
        activity_date = COALESCE($2::date, activity_date),
        activity_type = COALESCE($3, activity_type),
        activity_form = COALESCE($4, activity_form),
        activity_name = COALESCE($5, activity_name),
        agenda = COALESCE($6, agenda),
        goal = COALESCE($7, goal),
        description_summary = COALESCE($8, description_summary),
        activity_time = COALESCE($9::time, activity_time),
        location = COALESCE($10, location),
        participants_count = CASE WHEN $11::int IS NOT NULL THEN $11 ELSE participants_count END,
        participants_list = COALESCE($12, participants_list),
        output = COALESCE($13, output),
        folder_bergkas_url = COALESCE($14, folder_bergkas_url),
        photo_url = CASE WHEN $15::text IS NOT NULL THEN $15 ELSE photo_url END,
        notulensi_url = CASE WHEN $16::text IS NOT NULL THEN $16 ELSE notulensi_url END,
        notulensi_name = CASE WHEN $17::text IS NOT NULL THEN $17 ELSE notulensi_name END,
        surat_url = CASE WHEN $18::text IS NOT NULL THEN $18 ELSE surat_url END,
        surat_name = CASE WHEN $19::text IS NOT NULL THEN $19 ELSE surat_name END,
        pic_name = COALESCE($20, pic_name),
        updated_at = NOW()
      WHERE id = $1
      `,
      [
        activityId,
        activityDate || null,
        activityType || null,
        activityForm || null,
        activityName || null,
        agenda || null,
        goal || null,
        descriptionSummary || null,
        activityTime || null,
        location || null,
        participantsCount != null ? Number(participantsCount) : null,
        participantsList || null,
        output || null,
        folderBergkasUrl || null,
        photoUrl || null,
        notulensiUrl || null,
        resolvedNotulensiName || null,
        suratUrl || null,
        resolvedSuratName || null,
        picName || null
      ]
    );

    res.json({
      message: "Kegiatan berhasil diubah.",
      photoUrl,
      notulensiUrl,
      suratUrl
    });
  })
);

/**
 * DELETE /api/activities/:id
 */
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat menghapus kegiatan." });
    }

    const activityId = requireSafeId(req.params.id, "id");
    await ensureActivitiesTable();

    const existing = await query("SELECT id FROM stas_activities WHERE id = $1", [activityId]);
    if (existing.rowCount === 0) {
      return res.status(404).json({ message: "Kegiatan tidak ditemukan." });
    }

    await query("DELETE FROM stas_activities WHERE id = $1", [activityId]);

    res.json({ message: "Kegiatan berhasil dihapus." });
  })
);

module.exports = router;
