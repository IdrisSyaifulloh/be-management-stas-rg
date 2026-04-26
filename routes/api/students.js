const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const bcrypt = require("bcrypt");

const router = express.Router();
let ensureStudentColumnsPromise = null;

async function ensureStudentColumns() {
  if (!ensureStudentColumnsPromise) {
    ensureStudentColumnsPromise = query(`
      ALTER TABLE students
      ADD COLUMN IF NOT EXISTS fakultas TEXT,
      ADD COLUMN IF NOT EXISTS bergabung DATE
    `);
  }
  await ensureStudentColumnsPromise;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function normalizeOptionalDate(value) {
  if (value == null || value === "") return null;
  const normalized = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const error = new Error("bergabung wajib format YYYY-MM-DD.");
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    await ensureStudentColumns();
    const result = await query(
      `
      SELECT s.id, s.user_id, s.nim, u.name, u.initials, u.prodi, s.angkatan, u.email, s.phone,
             s.fakultas, s.status, s.tipe, TO_CHAR(s.bergabung, 'YYYY-MM-DD') AS bergabung, s.pembimbing,
             s.kehadiran, s.total_hari, s.logbook_count, s.jam_minggu_ini, s.jam_minggu_target,
             COALESCE(
               array_agg(DISTINCT rp.title) FILTER (WHERE rp.title IS NOT NULL),
               ARRAY[]::text[]
             ) as research_projects
      FROM students s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN research_memberships rm ON rm.user_id = u.id AND rm.member_type = 'Mahasiswa'
      LEFT JOIN research_projects rp ON rp.id = rm.project_id
      GROUP BY s.id, u.name, u.initials, u.prodi, s.angkatan, u.email, s.phone,
               s.fakultas, s.status, s.tipe, s.bergabung, s.pembimbing,
               s.kehadiran, s.total_hari, s.logbook_count, s.jam_minggu_ini, s.jam_minggu_target
      ORDER BY u.name ASC
      `
    );

    res.json(result.rows);
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    await ensureStudentColumns();
    const result = await query(
      `
      SELECT s.id, s.user_id, s.nim, u.name, u.initials, u.prodi, s.angkatan, u.email, s.phone,
             s.fakultas, s.status, s.tipe, TO_CHAR(s.bergabung, 'YYYY-MM-DD') AS bergabung, s.pembimbing,
             s.kehadiran, s.total_hari, s.logbook_count, s.jam_minggu_ini, s.jam_minggu_target,
             COALESCE(
               array_agg(DISTINCT rp.title) FILTER (WHERE rp.title IS NOT NULL),
               ARRAY[]::text[]
             ) as research_projects
      FROM students s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN research_memberships rm ON rm.user_id = u.id AND rm.member_type = 'Mahasiswa'
      LEFT JOIN research_projects rp ON rp.id = rm.project_id
      WHERE s.id = $1
      GROUP BY s.id, u.name, u.initials, u.prodi, s.angkatan, u.email, s.phone,
               s.fakultas, s.status, s.tipe, s.bergabung, s.pembimbing,
               s.kehadiran, s.total_hari, s.logbook_count, s.jam_minggu_ini, s.jam_minggu_target
      `,
      [req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    }

    res.json(result.rows[0]);
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const {
      nim,
      name,
      initials,
      prodi,
      angkatan,
      fakultas,
      email,
      phone,
      status,
      tipe,
      bergabung,
      pembimbing,
      password
    } = req.body;

    if (!nim || !name || !initials || !status || !tipe || !password) {
      return res.status(400).json({ message: "nim, name, initials, status, tipe, password wajib diisi." });
    }

    await ensureStudentColumns();
    const normalizedBergabung = normalizeOptionalDate(bergabung);

    await query("BEGIN");
    try {
      // Generate unique IDs
      const timestamp = Date.now();
      const randomSuffix = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
      const userId = `usr_mhs_${timestamp}${randomSuffix}`;
      const studentId = `stu_${timestamp}${randomSuffix}`;

      const passwordHash = await bcrypt.hash(password, 10);
      
      // Insert user first
      await query(
        `
        INSERT INTO users (id, name, initials, role, email, prodi, password_hash)
        VALUES ($1, $2, $3, 'mahasiswa', $4, $5, $6)
        `,
        [userId, name, initials, email || null, prodi || null, passwordHash]
      );

      // Insert student with user_id referencing the user
      await query(
        `
        INSERT INTO students (id, user_id, nim, angkatan, fakultas, phone, status, tipe, bergabung, pembimbing)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::date, CURRENT_DATE), $10)
        `,
        [studentId, userId, nim, angkatan || null, fakultas || null, phone || null, status, tipe, normalizedBergabung, pembimbing || null]
      );

      await query("COMMIT");
      return res.status(201).json({ 
        message: "Mahasiswa berhasil ditambahkan.",
        data: { userId, studentId }
      });
    } catch (error) {
      await query("ROLLBACK");
      throw error;
    }
  })
);

router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const {
      nim,
      name,
      initials,
      prodi,
      angkatan,
      fakultas,
      email,
      phone,
      status,
      tipe,
      bergabung,
      pembimbing,
      password
    } = req.body;

    await ensureStudentColumns();
    const normalizedBergabung = hasOwn(req.body || {}, "bergabung") ? normalizeOptionalDate(bergabung) : null;

    await query("BEGIN");
    try {
      // BUG FIX 1: Resolve student ID → user_id sebelum update tabel users.
      // GET mengembalikan s.id (student ID), tapi users.id berbeda (user ID).
      // Dukung keduanya agar endpoint tidak rapuh.
      const studentRecord = await query(
        `SELECT s.id AS student_id, s.user_id, s.status AS current_status
         FROM students s
         WHERE s.id = $1 OR s.user_id = $1
         LIMIT 1`,
        [id]
      );

      if (studentRecord.rowCount === 0) {
        await query("ROLLBACK");
        return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
      }

      const { student_id: studentId, user_id: userId, current_status: previousStatus } = studentRecord.rows[0];

      let passwordHash = null;
      if (password && String(password).trim() !== '') {
        passwordHash = await bcrypt.hash(password, 10);
      }

      // Update tabel users menggunakan user_id yang benar
      await query(
        `UPDATE users
         SET name          = COALESCE($2, name),
             initials      = COALESCE($3, initials),
             prodi         = COALESCE($4, prodi),
             email         = COALESCE($5, email),
             password_hash = COALESCE($6, password_hash),
             updated_at    = NOW()
         WHERE id = $1 AND role = 'mahasiswa'`,
        [userId, name, initials, prodi, email, passwordHash]
      );

      // BUG FIX 2: Hanya set withdrawal timestamps saat benar-benar transisi status,
      // bukan setiap kali status 'Mengundurkan Diri' di-save ulang (yang akan reset withdrawal_at).
      const isWithdrawing = previousStatus !== 'Mengundurkan Diri' && status === 'Mengundurkan Diri';

      await query(
        `UPDATE students
         SET nim                   = COALESCE($2, nim),
             angkatan              = COALESCE($3, angkatan),
             fakultas              = CASE WHEN $4::boolean THEN $5 ELSE fakultas END,
             phone                 = COALESCE($6, phone),
             status                = COALESCE($7, status),
             tipe                  = COALESCE($8, tipe),
             bergabung             = CASE WHEN $9::boolean THEN $10::date ELSE bergabung END,
             pembimbing            = COALESCE($11, pembimbing),
             withdrawal_at         = CASE WHEN $12 THEN NOW() ELSE withdrawal_at END,
             scheduled_deletion_at = CASE WHEN $12 THEN NOW() + INTERVAL '30 days' ELSE scheduled_deletion_at END,
             updated_at            = NOW()
         WHERE id = $1`,
        [
          studentId,
          nim,
          angkatan,
          hasOwn(req.body || {}, "fakultas"),
          fakultas == null || fakultas === "" ? null : String(fakultas),
          phone,
          status,
          tipe,
          hasOwn(req.body || {}, "bergabung"),
          normalizedBergabung,
          pembimbing,
          isWithdrawing
        ]
      );

      // BUG FIX 3: Role mapping yang benar; hindari null pada kolom NOT NULL.
      if (isWithdrawing) {
        const auditId = `aud_withdrawal_${Date.now()}`;
        const authUser = req.authUser;
        const roleMap = { mahasiswa: 'Mahasiswa', dosen: 'Dosen', operator: 'Operator' };
        const auditRole = roleMap[authUser?.role] || 'Operator';
        await query(
          `INSERT INTO audit_logs (id, user_id, user_role, action, target, detail)
           VALUES ($1, $2, $3, 'Update', 'student_withdrawal', $4)`,
          [
            auditId,
            authUser?.id || null,
            auditRole,
            JSON.stringify({
              student_id: studentId,
              previous_status: previousStatus,
              new_status: 'Mengundurkan Diri',
              withdrawal_at: new Date().toISOString(),
              scheduled_deletion_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
              message: 'Student withdrawn - account set to Temporary HOLD for 30 days'
            })
          ]
        );
      }

      await query("COMMIT");
      return res.json({
        message: "Data mahasiswa berhasil diperbarui.",
        ...(isWithdrawing && {
          warning: "Mahasiswa telah mengundurkan diri. Akun dalam status Temporary HOLD dan akan dihapus dalam 30 hari.",
          scheduled_deletion_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        })
      });
    } catch (error) {
      await query("ROLLBACK");
      throw error;
    }
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    // Coba hapus berdasarkan user_id terlebih dahulu
    let result = await query(
      "DELETE FROM users WHERE id = $1 AND role = 'mahasiswa' RETURNING id",
      [req.params.id]
    );

    // Jika tidak ketemu, coba cari berdasarkan student_id
    if (result.rowCount === 0) {
      const studentCheck = await query(
        "SELECT user_id FROM students WHERE id = $1",
        [req.params.id]
      );
      if (studentCheck.rowCount > 0) {
        result = await query(
          "DELETE FROM users WHERE id = $1 AND role = 'mahasiswa' RETURNING id",
          [studentCheck.rows[0].user_id]
        );
      }
    }

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    }

    return res.json({ message: "Mahasiswa berhasil dihapus." });
  })
);

module.exports = router;
