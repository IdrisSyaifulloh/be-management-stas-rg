const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const bcrypt = require("bcrypt");

const router = express.Router();

router.get(
  "/:userId",
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const result = await query(
      `
      SELECT u.id, u.name, u.email, u.prodi, u.role, s.id AS student_id, s.nim, s.phone, s.angkatan, s.status, s.pembimbing, s.bergabung
      FROM users u
      LEFT JOIN students s ON s.user_id = u.id
      WHERE u.id = $1
      `,
      [userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Profil pengguna tidak ditemukan." });
    }

    res.json(result.rows[0]);
  })
);

router.patch(
  "/:userId",
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { name, phone, email, prodi } = req.body;

    await query(
      `
      UPDATE users
      SET name = COALESCE($2, name),
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
      SET phone = COALESCE($2, phone),
          updated_at = NOW()
      WHERE user_id = $1
      `,
      [userId, phone]
    );

    res.json({ message: "Profil berhasil diperbarui." });
  })
);

router.put(
  "/:userId/password",
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { newPassword } = req.body;
    if (!newPassword) {
      return res.status(400).json({ message: "Password baru wajib diisi." });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await query(
      `
      UPDATE users
      SET password_hash = $2,
          updated_at = NOW()
      WHERE id = $1
      `,
      [userId, passwordHash]
    );

    res.json({ message: "Password berhasil diperbarui." });
  })
);

module.exports = router;
