// routes/api/auth.js
const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const bcrypt = require("bcrypt"); // ← TAMBAH INI

const router = express.Router();

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({
        message: "identifier dan password wajib diisi (id/email/nim/nip).",
      });
    }

    const result = await query(
      `
      SELECT u.id, u.name, u.initials, u.role, u.prodi, u.password_hash, u.is_active,
             s.nim, s.status AS student_status, s.withdrawal_at, s.scheduled_deletion_at,
             l.nip
      FROM users u
      LEFT JOIN students s ON s.user_id = u.id
      LEFT JOIN lecturers l ON l.user_id = u.id
      WHERE u.id = $1 OR u.email = $1 OR s.nim = $1 OR l.nip = $1
      LIMIT 1
      `,
      [identifier],
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ message: "User tidak ditemukan." });
    }

    const user = result.rows[0];

    // Check if student account is in Temporary HOLD status
    if (user.role === 'mahasiswa' && user.student_status === 'Mengundurkan Diri' && user.withdrawal_at) {
      const withdrawalDate = new Date(user.withdrawal_at);
      const now = new Date();
      const daysSinceWithdrawal = Math.floor((now - withdrawalDate) / (1000 * 60 * 60 * 24));
      
      if (daysSinceWithdrawal < 30) {
        return res.status(403).json({ 
          message: "Akun Anda dalam status Temporary HOLD karena telah mengundurkan diri. Akun akan dihapus setelah 30 hari.",
          withdrawal_at: user.withdrawal_at,
          scheduled_deletion_at: user.scheduled_deletion_at,
          days_remaining: 30 - daysSinceWithdrawal
        });
      }
    }

    // Check if user account is inactive
    if (user.is_active === false) {
      return res.status(403).json({ message: "Akun Anda tidak aktif. Hubungi administrator untuk bantuan." });
    }

    // ← GANTI BAGIAN INI (bcrypt compare)
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!user.password_hash || !validPassword) {
      return res.status(401).json({ message: "Password salah." });
    }

    const { z } = require("zod");

    const loginSchema = z.object({
      identifier: z.string().min(1, "identifier wajib diisi"),
      password: z.string().min(6, "password minimal 6 karakter"),
    });

    // Di dalam route:
    const validation = loginSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({
        message: "Validasi gagal",
        errors: validation.error.errors,
      });
    }
    return res.json({
      user: {
        id: user.id,
        name: user.name,
        initials: user.initials,
        role: user.role,
        prodi: user.prodi,
      },
    });
  }),
);

module.exports = router;
