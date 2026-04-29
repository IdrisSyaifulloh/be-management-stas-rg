const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const bcrypt = require("bcrypt");
const { requireSafeId } = require("../../utils/securityValidation");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const router = express.Router();

const PROFILE_UPLOAD_DIR = path.join(__dirname, "../../public/uploads/profile");
const MAX_PROFILE_PHOTO_SIZE = 2 * 1024 * 1024;

const ALLOWED_PROFILE_PHOTO_TYPES = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif"
};

let ensureProfileColumnsPromise = null;

async function ensureProfileColumns() {
  if (!ensureProfileColumnsPromise) {
    ensureProfileColumnsPromise = (async () => {
      await query(`
        ALTER TABLE students
        ADD COLUMN IF NOT EXISTS wfh_quota INTEGER NOT NULL DEFAULT 0
      `);

      await query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS photo_url TEXT
      `);
    })();
  }

  await ensureProfileColumnsPromise;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function getRequestBaseUrl(req) {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;

  if (!host) return "";

  return `${protocol}://${host}`;
}

function resolvePhotoUrl(req, value) {
  const photoUrl = String(value || "").trim();

  if (!photoUrl) return null;

  if (/^https?:\/\//i.test(photoUrl)) {
    return photoUrl;
  }

  if (photoUrl.startsWith("/")) {
    return `${getRequestBaseUrl(req)}${photoUrl}`;
  }

  return photoUrl;
}

function mapProfileRow(row, req) {
  const wfhUsed = Number(row.wfh_used || 0);
  const wfhQuota = Number(row.wfh_quota || 0);
  const wfhRemaining = Math.max(0, wfhQuota - wfhUsed);
  const photoUrl = resolvePhotoUrl(req, row.photo_url);

  return {
    ...row,
    photo_url: photoUrl,
    photoUrl,
    wfh_quota: wfhQuota,
    wfhQuota,
    manual_wfh_quota: wfhQuota,
    manualWfhQuota: wfhQuota,
    mentor_wfh_quota: null,
    mentorWfhQuota: null,
    effective_wfh_quota: wfhQuota,
    effectiveWfhQuota: wfhQuota,
    wfh_quota_source: "student",
    wfhQuotaSource: "student",
    wfh_used: wfhUsed,
    wfhUsed,
    wfh_remaining: wfhRemaining,
    wfhRemaining
  };
}

function sanitizeFilenameBase(name) {
  return (
    String(name || "profile-photo")
      .replace(/\.[^/.]+$/, "")
      .replace(/[^a-zA-Z0-9-_]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "profile-photo"
  );
}

function resolveProfilePhotoPath(photoUrl) {
  const normalized = String(photoUrl || "").trim();

  if (!normalized.startsWith("/uploads/profile/")) {
    return null;
  }

  return path.join(PROFILE_UPLOAD_DIR, path.basename(normalized));
}

async function removeProfilePhoto(photoUrl) {
  const targetPath = resolveProfilePhotoPath(photoUrl);

  if (!targetPath) return;

  try {
    await fs.unlink(targetPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function saveProfilePhoto({ photoDataUrl, fileName }) {
  const match = String(photoDataUrl || "").match(/^data:([^;]+);base64,(.+)$/);

  if (!match) {
    const error = new Error("Format foto tidak valid. Gunakan data URL base64.");
    error.statusCode = 400;
    throw error;
  }

  const mimeType = match[1];
  const base64Payload = match[2].replace(/\s/g, "");
  const extension = ALLOWED_PROFILE_PHOTO_TYPES[mimeType];

  if (!extension) {
    const error = new Error("Tipe foto harus JPG, PNG, atau GIF.");
    error.statusCode = 400;
    throw error;
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Payload) || base64Payload.length % 4 !== 0) {
    const error = new Error("Payload foto base64 tidak valid.");
    error.statusCode = 400;
    throw error;
  }

  const buffer = Buffer.from(base64Payload, "base64");

  if (!buffer || buffer.length === 0) {
    const error = new Error("Foto kosong tidak dapat diunggah.");
    error.statusCode = 400;
    throw error;
  }

  if (buffer.length > MAX_PROFILE_PHOTO_SIZE) {
    const error = new Error("Ukuran foto maksimal 2 MB.");
    error.statusCode = 400;
    throw error;
  }

  await fs.mkdir(PROFILE_UPLOAD_DIR, { recursive: true });

  const safeBaseName = sanitizeFilenameBase(fileName);
  const finalFileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeBaseName}${extension}`;
  const finalPath = path.join(PROFILE_UPLOAD_DIR, finalFileName);

  await fs.writeFile(finalPath, buffer);

  return {
    photoUrl: `/uploads/profile/${finalFileName}`,
    fileName: finalFileName,
    fileSize: buffer.length
  };
}

router.post(
  "/photo",
  asyncHandler(async (req, res) => {
    await ensureProfileColumns();

    const { userId, photoDataUrl, fileName } = req.body || {};

    if (!userId || !photoDataUrl) {
      return res.status(400).json({
        message: "userId dan photoDataUrl wajib diisi."
      });
    }

    const safeUserId = requireSafeId(userId, "userId");

    const existingUser = await query(
      `
      SELECT id, photo_url
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [safeUserId]
    );

    if (existingUser.rowCount === 0) {
      return res.status(404).json({
        message: "Pengguna tidak ditemukan."
      });
    }

    const uploaded = await saveProfilePhoto({
      photoDataUrl,
      fileName
    });

    await query(
      `
      UPDATE users
      SET photo_url = $2,
          updated_at = NOW()
      WHERE id = $1
      `,
      [safeUserId, uploaded.photoUrl]
    );

    const oldPhotoUrl = existingUser.rows[0]?.photo_url;

    if (oldPhotoUrl && oldPhotoUrl !== uploaded.photoUrl) {
      try {
        await removeProfilePhoto(oldPhotoUrl);
      } catch {
        // Jangan gagalkan upload kalau cleanup file lama gagal.
      }
    }

    res.status(201).json({
      message: "Foto profil berhasil diunggah.",
      photo_url: resolvePhotoUrl(req, uploaded.photoUrl),
      photoUrl: resolvePhotoUrl(req, uploaded.photoUrl),
      fileName: uploaded.fileName,
      fileSize: uploaded.fileSize
    });
  })
);

router.delete(
  "/photo/:userId",
  asyncHandler(async (req, res) => {
    await ensureProfileColumns();

    const userId = requireSafeId(req.params.userId, "userId");

    const existingUser = await query(
      `
      SELECT id, photo_url
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [userId]
    );

    if (existingUser.rowCount === 0) {
      return res.status(404).json({
        message: "Pengguna tidak ditemukan."
      });
    }

    await query(
      `
      UPDATE users
      SET photo_url = NULL,
          updated_at = NOW()
      WHERE id = $1
      `,
      [userId]
    );

    try {
      await removeProfilePhoto(existingUser.rows[0]?.photo_url);
    } catch {
      // Abaikan cleanup file gagal.
    }

    res.json({
      message: "Foto profil berhasil dihapus."
    });
  })
);

router.get(
  "/:userId",
  asyncHandler(async (req, res) => {
    await ensureProfileColumns();

    const userId = requireSafeId(req.params.userId, "userId");

    const result = await query(
      `
      SELECT 
        u.id,
        u.name,
        u.email,
        u.prodi,
        u.role,
        u.photo_url,
        s.id AS student_id,
        s.nim,
        s.phone,
        s.angkatan,
        s.status,
        s.tipe,
        s.pembimbing,
        s.bergabung,
        COALESCE(s.wfh_quota, 0)::int AS wfh_quota,
        COUNT(lr.id)::int AS wfh_used
      FROM users u
      LEFT JOIN students s ON s.user_id = u.id
      LEFT JOIN leave_requests lr 
        ON lr.student_id = s.id 
       AND lr.jenis_pengajuan = 'wfh' 
       AND lr.status = 'Disetujui'
       AND lr.counts_against_wfh_quota IS NOT FALSE
      WHERE u.id = $1
      GROUP BY 
        u.id,
        u.name,
        u.email,
        u.prodi,
        u.role,
        u.photo_url,
        s.id,
        s.nim,
        s.phone,
        s.angkatan,
        s.status,
        s.tipe,
        s.pembimbing,
        s.bergabung,
        s.wfh_quota
      `,
      [userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        message: "Profil pengguna tidak ditemukan."
      });
    }

    res.json(mapProfileRow(result.rows[0], req));
  })
);

router.patch(
  "/:userId",
  asyncHandler(async (req, res) => {
    await ensureProfileColumns();

    const userId = requireSafeId(req.params.userId, "userId");
    const { name, phone, email, prodi, photoUrl, photo_url: photoUrlSnake } = req.body || {};

    const hasPhotoUrl = hasOwn(req.body || {}, "photoUrl") || hasOwn(req.body || {}, "photo_url");
    const nextPhotoUrl = photoUrl ?? photoUrlSnake ?? null;

    const existingUser = await query(
      `
      SELECT id, photo_url
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [userId]
    );

    if (existingUser.rowCount === 0) {
      return res.status(404).json({
        message: "Pengguna tidak ditemukan."
      });
    }

    await query(
      `
      UPDATE users
      SET 
        name = COALESCE($2, name),
        email = COALESCE($3, email),
        prodi = COALESCE($4, prodi),
        photo_url = CASE WHEN $5::boolean THEN $6 ELSE photo_url END,
        updated_at = NOW()
      WHERE id = $1
      `,
      [userId, name, email, prodi, hasPhotoUrl, nextPhotoUrl]
    );

    await query(
      `
      UPDATE students
      SET 
        phone = COALESCE($2, phone),
        updated_at = NOW()
      WHERE user_id = $1
      `,
      [userId, phone]
    );

    if (hasPhotoUrl && !nextPhotoUrl) {
      try {
        await removeProfilePhoto(existingUser.rows[0]?.photo_url);
      } catch {
        // Abaikan cleanup file gagal.
      }
    }

    res.json({
      message: "Profil berhasil diperbarui."
    });
  })
);

router.put(
  "/:userId/password",
  asyncHandler(async (req, res) => {
    const userId = requireSafeId(req.params.userId, "userId");
    const { newPassword } = req.body || {};

    if (!newPassword) {
      return res.status(400).json({
        message: "Password baru wajib diisi."
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    await query(
      `
      UPDATE users
      SET 
        password_hash = $2,
        updated_at = NOW()
      WHERE id = $1
      `,
      [userId, passwordHash]
    );

    res.json({
      message: "Password berhasil diperbarui."
    });
  })
);

module.exports = router;