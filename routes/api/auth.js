const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");

const router = express.Router();

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ message: "identifier dan password wajib diisi (id/email/nim/nip)." });
    }

    const result = await query(
      `
      SELECT u.id, u.name, u.initials, u.role, u.prodi, u.password_hash,
             s.nim,
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

    if (!user.password_hash || user.password_hash !== await query("SELECT md5($1) AS hash", [password]).then((r) => r.rows[0].hash)) {
      return res.status(401).json({ message: "Password salah." });
    }

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        initials: user.initials,
        role: user.role,
        prodi: user.prodi
      }
    });
  })
);

module.exports = router;
