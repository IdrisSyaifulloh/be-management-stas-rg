const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const bcrypt = require("bcrypt");

const router = express.Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const result = await query(
      `
      SELECT s.id, s.user_id, s.nim, u.name, u.initials, u.prodi, s.angkatan, u.email, s.phone,
             s.status, s.tipe, s.bergabung, s.pembimbing,
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
               s.status, s.tipe, s.bergabung, s.pembimbing,
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
    const result = await query(
      `
      SELECT s.id, s.user_id, s.nim, u.name, u.initials, u.prodi, s.angkatan, u.email, s.phone,
             s.status, s.tipe, s.bergabung, s.pembimbing,
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
               s.status, s.tipe, s.bergabung, s.pembimbing,
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
      email,
      phone,
      status,
      tipe,
      pembimbing,
      password
    } = req.body;

    if (!nim || !name || !initials || !status || !tipe || !password) {
      return res.status(400).json({ message: "nim, name, initials, status, tipe, password wajib diisi." });
    }

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
        INSERT INTO students (id, user_id, nim, angkatan, phone, status, tipe, pembimbing)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [studentId, userId, nim, angkatan || null, phone || null, status, tipe, pembimbing || null]
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
      email,
      phone,
      status,
      tipe,
      pembimbing,
      password
    } = req.body;

    await query("BEGIN");
    try {
      let passwordHash = null;
      if (password && String(password).trim() !== '') {
        passwordHash = await bcrypt.hash(password, 10);
      }

      const userResult = await query(
        `
        UPDATE users
        SET name = COALESCE($2, name),
            initials = COALESCE($3, initials),
            prodi = COALESCE($4, prodi),
            email = COALESCE($5, email),
            password_hash = COALESCE($6, password_hash),
            updated_at = NOW()
        WHERE id = $1 AND role = 'mahasiswa'
        RETURNING id, role
        `,
        [id, name, initials, prodi, email, passwordHash]
      );

      if (userResult.rowCount === 0) {
        await query("ROLLBACK");
        return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
      }

      // Get current student status to check for withdrawal transition
      const currentStudent = await query(
        `SELECT status FROM students WHERE id = $1`,
        [id]
      );

      const previousStatus = currentStudent.rowCount > 0 ? currentStudent.rows[0].status : null;
      const isWithdrawing = previousStatus !== 'Mengundurkan Diri' && status === 'Mengundurkan Diri';

      // Set withdrawal timestamps if status changes to Mengundurkan Diri
      const withdrawalAt = isWithdrawing ? 'NOW()' : 'withdrawal_at';
      const scheduledDeletionAt = isWithdrawing ? 'NOW() + INTERVAL \'30 days\'' : 'scheduled_deletion_at';

      await query(
        `
        UPDATE students
        SET nim = COALESCE($2, nim),
            angkatan = COALESCE($3, angkatan),
            phone = COALESCE($4, phone),
            status = COALESCE($5, status),
            tipe = COALESCE($6, tipe),
            pembimbing = COALESCE($7, pembimbing),
            withdrawal_at = CASE WHEN $5 = 'Mengundurkan Diri' THEN NOW() ELSE withdrawal_at END,
            scheduled_deletion_at = CASE WHEN $5 = 'Mengundurkan Diri' THEN NOW() + INTERVAL '30 days' ELSE scheduled_deletion_at END,
            updated_at = NOW()
        WHERE id = $1
        `,
        [id, nim, angkatan, phone, status, tipe, pembimbing]
      );

      // Log the withdrawal action for audit
      if (isWithdrawing) {
        const auditId = `aud_withdrawal_${Date.now()}`;
        const authUser = req.authUser;
        await query(
          `
          INSERT INTO audit_logs (id, user_id, user_role, action, target, detail)
          VALUES ($1, $2, $3, 'Update', 'student_withdrawal', $4)
          `,
          [auditId, authUser?.id || null, authUser?.role ? 'Operator' : null, JSON.stringify({
            student_id: id,
            previous_status: previousStatus,
            new_status: 'Mengundurkan Diri',
            withdrawal_at: new Date().toISOString(),
            scheduled_deletion_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            message: 'Student withdrawn - account set to Temporary HOLD for 30 days'
          })]
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
    const result = await query("DELETE FROM users WHERE id = $1 AND role = 'mahasiswa' RETURNING id", [req.params.id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    }

    return res.json({ message: "Mahasiswa berhasil dihapus." });
  })
);

module.exports = router;
