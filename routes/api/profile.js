const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const bcrypt = require("bcrypt");
const { requireSafeId } = require("../../utils/securityValidation");

const router = express.Router();

let ensureProfileStudentColumnsPromise = null;

async function ensureProfileStudentColumns() {
  if (!ensureProfileStudentColumnsPromise) {
    ensureProfileStudentColumnsPromise = query(`
      ALTER TABLE students
      ADD COLUMN IF NOT EXISTS wfh_quota INTEGER NOT NULL DEFAULT 0
    `);
  }

  await ensureProfileStudentColumnsPromise;
}

function mapProfileRow(row) {
  const wfhUsed = Number(row.wfh_used || 0);
  const wfhQuota = Number(row.wfh_quota || 0);
  const wfhRemaining = Math.max(0, wfhQuota - wfhUsed);

  return {
    ...row,
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

router.get(
  "/:userId",
  asyncHandler(async (req, res) => {
    await ensureProfileStudentColumns();

    const userId = requireSafeId(req.params.userId, "userId");

    const result = await query(
      `
      SELECT 
        u.id,
        u.name,
        u.email,
        u.prodi,
        u.role,
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

    res.json(mapProfileRow(result.rows[0]));
  })
);

router.patch(
  "/:userId",
  asyncHandler(async (req, res) => {
    const userId = requireSafeId(req.params.userId, "userId");
    const { name, phone, email, prodi } = req.body;

    await query(
      `
      UPDATE users
      SET 
        name = COALESCE($2, name),
        email = COALESCE($3, email),
        prodi = COALESCE($4, prodi),
        updated_at = NOW()
      WHERE id = $1
      `,
      [userId, name, email, prodi]
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

    res.json({
      message: "Profil berhasil diperbarui."
    });
  })
);

router.put(
  "/:userId/password",
  asyncHandler(async (req, res) => {
    const userId = requireSafeId(req.params.userId, "userId");
    const { newPassword } = req.body;

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