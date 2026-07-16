const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const bcrypt = require("bcrypt");
const { requireSafeId } = require("../../utils/securityValidation");
const { getJakartaWeekBounds } = require("../../utils/jakartaWeek");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { ensureStudentDocumentsTable, fetchStudentDocuments } = require("../../utils/studentDocuments");

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
        ADD COLUMN IF NOT EXISTS fakultas TEXT,
        ADD COLUMN IF NOT EXISTS bio TEXT,
        ADD COLUMN IF NOT EXISTS wfh_quota INTEGER NOT NULL DEFAULT 0
      `);

      await query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS photo_url TEXT
      `);

      await ensureStudentDocumentsTable();
    })();
  }

  await ensureProfileColumnsPromise;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function normalizeOptionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeRequiredText(value, fieldName) {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    const error = new Error(`${fieldName} wajib diisi.`);
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function normalizeOptionalDateField(value, fieldName) {
  if (value == null || value === "") return null;

  const normalized = String(value).trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const error = new Error(`${fieldName} wajib format YYYY-MM-DD.`);
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function normalizeOptionalEmail(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;

  if (normalized.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    const error = new Error("Email mahasiswa wajib berupa alamat email valid.");
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function normalizeStudentStatus(value) {
  const normalized = normalizeRequiredText(value, "Status mahasiswa");
  const allowed = ["Aktif", "Cuti", "Alumni", "Mengundurkan Diri"];

  if (!allowed.includes(normalized)) {
    const error = new Error("Status mahasiswa tidak valid.");
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function normalizeStudentType(value) {
  const normalized = normalizeRequiredText(value, "Tipe mahasiswa");
  const allowed = ["Riset", "Magang"];

  if (!allowed.includes(normalized)) {
    const error = new Error("Tipe mahasiswa tidak valid.");
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function makeInitials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return `${parts[0]?.[0] || ""}${parts[1]?.[0] || ""}`.toUpperCase();
}

async function ensureProfileEmailAvailable(email, excludeUserId = null) {
  if (!email) return;

  const result = await query(
    `
    SELECT id
    FROM users
    WHERE LOWER(email) = LOWER($1)
      AND ($2::text IS NULL OR id <> $2)
    LIMIT 1
    `,
    [email, excludeUserId || null]
  );

  if (result.rowCount > 0) {
    const error = new Error("Email sudah digunakan oleh akun lain.");
    error.statusCode = 409;
    throw error;
  }
}

async function ensureProfileNimAvailable(nim, excludeUserId = null) {
  if (!nim) return;

  const result = await query(
    `
    SELECT s.id
    FROM students s
    WHERE s.nim = $1
      AND ($2::text IS NULL OR s.user_id <> $2)
    LIMIT 1
    `,
    [nim, excludeUserId || null]
  );

  if (result.rowCount > 0) {
    const error = new Error("NIM sudah digunakan oleh mahasiswa lain.");
    error.statusCode = 409;
    throw error;
  }
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
    const weekBounds = getJakartaWeekBounds(new Date());

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
        s.fakultas,
        s.status,
        s.tipe,
        s.pembimbing,
        s.bergabung,
        s.bio,
        COALESCE(s.wfh_quota, 0)::int AS wfh_quota,
        COUNT(lr.id)::int AS wfh_used
      FROM users u
      LEFT JOIN students s ON s.user_id = u.id
      LEFT JOIN leave_requests lr 
        ON lr.student_id = s.id 
       AND lr.jenis_pengajuan = 'wfh' 
       AND lr.status = 'Disetujui'
       AND lr.counts_against_wfh_quota IS NOT FALSE
       AND lr.periode_start BETWEEN $2::date AND $3::date
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
        s.fakultas,
        s.status,
        s.tipe,
        s.pembimbing,
        s.bergabung,
        s.bio,
        s.wfh_quota
      `,
        [userId, weekBounds.startDate, weekBounds.endDate]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        message: "Profil pengguna tidak ditemukan."
      });
    }

    const mappedProfile = mapProfileRow(result.rows[0], req);
    const studentDocuments = result.rows[0].student_id
      ? await fetchStudentDocuments(result.rows[0].student_id, result.rows[0].status)
      : [];

    res.json({
      ...mappedProfile,
      student_documents: studentDocuments,
      studentDocuments
    });
  })
);


router.post(
  "/finish-stas",
  asyncHandler(async (req, res) => {
    await ensureProfileColumns();

    if (req.authUser?.role !== "mahasiswa") {
      return res.status(403).json({ message: "Aksi ini hanya bisa dilakukan oleh mahasiswa." });
    }

    const userId = req.authUser.id;

    const studentResult = await query(
      `
      SELECT id, user_id, status
      FROM students
      WHERE user_id = $1
      LIMIT 1
      `,
      [userId]
    );

    if (studentResult.rowCount === 0) {
      return res.status(404).json({ message: "Data mahasiswa tidak ditemukan." });
    }

    const student = studentResult.rows[0];

    if (student.status === "Mengundurkan Diri") {
      return res.status(400).json({ message: "Mahasiswa yang mengundurkan diri tidak bisa menyelesaikan status sebagai Alumni lewat menu ini." });
    }

    if (student.status !== "Alumni") {
      await query("BEGIN");
      try {
        await query(
          `
          UPDATE students
          SET status = 'Alumni',
              updated_at = NOW()
          WHERE id = $1
          `,
          [student.id]
        );

        await query(
          `
          UPDATE research_memberships
          SET peran = 'Alumni',
              selesai = COALESCE(selesai, CURRENT_DATE),
              updated_at = NOW()
          WHERE user_id = $1
            AND member_type = 'Mahasiswa'
          `,
          [userId]
        );

        await query(
          `
          INSERT INTO audit_logs (id, user_id, user_role, action, target, detail)
          VALUES ($1, $2, 'Mahasiswa', 'Update', 'student_finish_stas', $3)
          `,
          [
            `aud_finish_stas_${Date.now()}`,
            userId,
            JSON.stringify({
              student_id: student.id,
              previous_status: student.status,
              new_status: "Alumni",
              finished_at: new Date().toISOString()
            })
          ]
        );

        await query("COMMIT");
      } catch (error) {
        await query("ROLLBACK");
        throw error;
      }
    }

    const documents = await fetchStudentDocuments(student.id, "Alumni");

    res.json({
      message: student.status === "Alumni" ? "Status Anda sudah Alumni." : "Status Anda berhasil diubah menjadi Alumni.",
      status: "Alumni",
      studentStatus: "Alumni",
      documents
    });
  })
);

router.patch(
  "/:userId",
  asyncHandler(async (req, res) => {
    await ensureProfileColumns();

    const userId = requireSafeId(req.params.userId, "userId");
    const payload = req.body || {};
    const {
      name,
      nim,
      phone,
      email,
      prodi,
      angkatan,
      fakultas,
      pembimbing,
      bio,
      photoUrl,
      photo_url: photoUrlSnake
    } = payload;

    const hasName = hasOwn(payload, "name");
    const hasNim = hasOwn(payload, "nim");
    const hasPhone = hasOwn(payload, "phone");
    const hasEmail = hasOwn(payload, "email");
    const hasProdi = hasOwn(payload, "prodi");
    const hasAngkatan = hasOwn(payload, "angkatan");
    const hasFakultas = hasOwn(payload, "fakultas");
    const hasPembimbing = hasOwn(payload, "pembimbing");
    const hasBio = hasOwn(payload, "bio");
    const hasPhotoUrl = hasOwn(payload, "photoUrl") || hasOwn(payload, "photo_url");

    const normalizedName = hasName ? normalizeRequiredText(name, "Nama lengkap") : null;
    const normalizedInitials = hasName ? makeInitials(normalizedName) : null;
    const normalizedNim = hasNim ? normalizeRequiredText(nim, "NIM") : null;
    const normalizedPhone = hasPhone ? normalizeOptionalText(phone) : null;
    const normalizedEmail = hasEmail ? normalizeOptionalEmail(email) : null;
    const normalizedProdi = hasProdi ? normalizeOptionalText(prodi) : null;
    const normalizedAngkatan = hasAngkatan ? normalizeOptionalText(angkatan) : null;
    const normalizedFakultas = hasFakultas ? normalizeOptionalText(fakultas) : null;
    const normalizedPembimbing = hasPembimbing ? normalizeOptionalText(pembimbing) : null;
    const normalizedBio = hasBio ? normalizeOptionalText(bio) : null;
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

    await ensureProfileEmailAvailable(normalizedEmail, userId);
    await ensureProfileNimAvailable(normalizedNim, userId);

    await query(
      `
      UPDATE users
      SET 
        name = CASE WHEN $2::boolean THEN $3 ELSE name END,
        initials = CASE WHEN $2::boolean THEN COALESCE($4, initials) ELSE initials END,
        email = CASE WHEN $5::boolean THEN $6 ELSE email END,
        prodi = CASE WHEN $7::boolean THEN $8 ELSE prodi END,
        photo_url = CASE WHEN $9::boolean THEN $10 ELSE photo_url END,
        updated_at = NOW()
      WHERE id = $1
      `,
      [
        userId,
        hasName,
        normalizedName,
        normalizedInitials,
        hasEmail,
        normalizedEmail,
        hasProdi,
        normalizedProdi,
        hasPhotoUrl,
        nextPhotoUrl
      ]
    );

    await query(
      `
      UPDATE students
      SET 
        nim = CASE WHEN $2::boolean THEN $3 ELSE nim END,
        phone = CASE WHEN $4::boolean THEN $5 ELSE phone END,
        angkatan = CASE WHEN $6::boolean THEN $7 ELSE angkatan END,
        fakultas = CASE WHEN $8::boolean THEN $9 ELSE fakultas END,
        pembimbing = CASE WHEN $10::boolean THEN $11 ELSE pembimbing END,
        bio = CASE WHEN $12::boolean THEN $13 ELSE bio END,
        updated_at = NOW()
      WHERE user_id = $1
      `,
      [
        userId,
        hasNim,
        normalizedNim,
        hasPhone,
        normalizedPhone,
        hasAngkatan,
        normalizedAngkatan,
        hasFakultas,
        normalizedFakultas,
        hasPembimbing,
        normalizedPembimbing,
        hasBio,
        normalizedBio
      ]
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

    const requester = req.authUser;
    if (!requester) {
      return res.status(401).json({ message: "Autentikasi diperlukan." });
    }

    const isOperator = requester.role === "operator";
    const isSelf = requester.id === userId;

    if (!isOperator && !isSelf) {
      return res.status(403).json({ message: "Akses ditolak." });
    }

    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({
        message: "Password baru wajib diisi dan minimal 6 karakter."
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

    const result = await query(
      `
      UPDATE users
      SET
        password_hash = $2,
        updated_at = NOW()
      WHERE id = $1
      RETURNING id
      `,
      [userId, passwordHash]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Pengguna tidak ditemukan." });
    }

    res.json({
      message: "Password berhasil diperbarui."
    });
  })
);

module.exports = router;