const express = require("express");
const bcrypt = require("bcrypt");
const { z } = require("zod");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");

const router = express.Router();

const loginSchema = z.object({
  identifier: z.string().min(1).max(160),
  password: z.string().min(6).max(200)
});

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const validation = loginSchema.safeParse(req.body);
    if (!validation.success) {
      return res.status(400).json({ message: "Input tidak valid." });
    }

    const { identifier, password } = validation.data;

    const result = await query(
      `
      SELECT u.id, u.name, u.initials, u.role, u.prodi, u.password_hash, u.is_active,
             s.nim, s.tipe, s.status AS student_status, s.withdrawal_at, s.scheduled_deletion_at,
             l.nip
      FROM users u
      LEFT JOIN students s ON s.user_id = u.id
      LEFT JOIN lecturers l ON l.user_id = u.id
      WHERE u.id = $1 OR u.email = $1 OR s.nim = $1 OR l.nip = $1
      LIMIT 1
      `,
      [identifier]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ message: "User tidak ditemukan." });
    }

    const user = result.rows[0];
    if (user.role === "mahasiswa" && user.student_status === "Mengundurkan Diri" && user.withdrawal_at) {
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

    if (user.is_active === false) {
      return res.status(403).json({ message: "Akun Anda tidak aktif. Hubungi administrator untuk bantuan." });
    }

    const validPassword = user.password_hash ? await bcrypt.compare(password, user.password_hash) : false;
    if (!validPassword) {
      return res.status(401).json({ message: "Password salah." });
    }

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        initials: user.initials,
        role: user.role,
        prodi: user.prodi,
        tipe: user.role === "mahasiswa" ? user.tipe : undefined
      }
    });
  })
);

module.exports = router;
