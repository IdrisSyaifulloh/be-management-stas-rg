const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");

const router = express.Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const result = await query(
      `
      SELECT s.id, s.nim, u.name, u.initials, u.prodi, s.angkatan, u.email, s.phone,
             s.status, s.tipe, s.bergabung, s.pembimbing,
             s.kehadiran, s.total_hari, s.logbook_count, s.jam_minggu_ini, s.jam_minggu_target
      FROM students s
      JOIN users u ON u.id = s.user_id
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
      SELECT s.id, s.nim, u.name, u.initials, u.prodi, s.angkatan, u.email, s.phone,
             s.status, s.tipe, s.bergabung, s.pembimbing,
             s.kehadiran, s.total_hari, s.logbook_count, s.jam_minggu_ini, s.jam_minggu_target
      FROM students s
      JOIN users u ON u.id = s.user_id
      WHERE s.id = $1
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
      id,
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

    if (!id || !nim || !name || !initials || !status || !tipe || !password) {
      return res.status(400).json({ message: "id, nim, name, initials, status, tipe, password wajib diisi." });
    }

    await query("BEGIN");
    try {
      await query(
        `
        INSERT INTO users (id, name, initials, role, email, prodi, password_hash)
        VALUES ($1, $2, $3, 'mahasiswa', $4, $5, md5($6))
        `,
        [id, name, initials, email || null, prodi || null, password]
      );

      await query(
        `
        INSERT INTO students (id, user_id, nim, angkatan, phone, status, tipe, pembimbing)
        VALUES ($1, $1, $2, $3, $4, $5, $6, $7)
        `,
        [id, nim, angkatan || null, phone || null, status, tipe, pembimbing || null]
      );

      await query("COMMIT");
      return res.status(201).json({ message: "Mahasiswa berhasil ditambahkan." });
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
      const userResult = await query(
        `
        UPDATE users
        SET name = COALESCE($2, name),
            initials = COALESCE($3, initials),
            prodi = COALESCE($4, prodi),
            email = COALESCE($5, email),
            password_hash = COALESCE(md5(NULLIF($6, '')), password_hash),
            updated_at = NOW()
        WHERE id = $1 AND role = 'mahasiswa'
        RETURNING id
        `,
        [id, name, initials, prodi, email, password || null]
      );

      if (userResult.rowCount === 0) {
        await query("ROLLBACK");
        return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
      }

      await query(
        `
        UPDATE students
        SET nim = COALESCE($2, nim),
            angkatan = COALESCE($3, angkatan),
            phone = COALESCE($4, phone),
            status = COALESCE($5, status),
            tipe = COALESCE($6, tipe),
            pembimbing = COALESCE($7, pembimbing),
            updated_at = NOW()
        WHERE id = $1
        `,
        [id, nim, angkatan, phone, status, tipe, pembimbing]
      );

      await query("COMMIT");
      return res.json({ message: "Data mahasiswa berhasil diperbarui." });
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
