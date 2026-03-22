const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");

const router = express.Router();

function normalizeKeahlian(input) {
  if (Array.isArray(input)) {
    return input
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  if (typeof input === "string") {
    return input
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function mapUniqueConstraintError(error) {
  if (!error || error.code !== "23505") return null;

  if (error.constraint === "users_email_key") {
    return { status: 409, message: "Email sudah digunakan oleh akun lain." };
  }

  if (error.constraint === "lecturers_nip_key") {
    return { status: 409, message: "NIP sudah terdaftar." };
  }

  if (error.constraint === "users_pkey" || error.constraint === "lecturers_pkey") {
    return { status: 409, message: "ID dosen sudah terdaftar." };
  }

  return { status: 409, message: "Data duplikat terdeteksi." };
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const result = await query(
      `
      SELECT l.id, l.nip, u.name, u.initials, u.email,
             l.departemen, l.jabatan, l.keahlian,
             l.riset_dipimpin, l.riset_diikuti,
             l.status, l.bergabung, l.mahasiswa_count
      FROM lecturers l
      JOIN users u ON u.id = l.user_id
      ORDER BY u.name ASC
      `
    );

    res.json(result.rows);
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const { id, nip, name, initials, email, departemen, jabatan, keahlian, status, password } = req.body;
    const normalizedKeahlian = normalizeKeahlian(keahlian);

    if (!id || !nip || !name || !initials || !status || !password) {
      return res.status(400).json({ message: "id, nip, name, initials, status, password wajib diisi." });
    }

    await query("BEGIN");
    try {
      await query(
        `
        INSERT INTO users (id, name, initials, role, email, password_hash)
        VALUES ($1, $2, $3, 'dosen', $4, md5($5))
        `,
        [id, name, initials, email || null, password]
      );

      await query(
        `
        INSERT INTO lecturers (id, user_id, nip, departemen, jabatan, keahlian, status)
        VALUES ($1, $1, $2, $3, $4, COALESCE($5::text[], '{}'::text[]), $6)
        `,
        [id, nip, departemen || null, jabatan || null, normalizedKeahlian, status]
      );

      await query("COMMIT");
      return res.status(201).json({ message: "Dosen berhasil ditambahkan." });
    } catch (error) {
      await query("ROLLBACK");
      const mappedError = mapUniqueConstraintError(error);
      if (mappedError) {
        return res.status(mappedError.status).json({ message: mappedError.message });
      }
      throw error;
    }
  })
);

router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { nip, name, initials, email, departemen, jabatan, keahlian, status, password } = req.body;
    const normalizedKeahlian = keahlian === undefined ? undefined : normalizeKeahlian(keahlian);

    await query("BEGIN");
    try {
      const userResult = await query(
        `
        UPDATE users
        SET name = COALESCE($2, name),
            initials = COALESCE($3, initials),
            email = COALESCE($4, email),
            password_hash = COALESCE(md5(NULLIF($5, '')), password_hash),
            updated_at = NOW()
        WHERE id = $1 AND role = 'dosen'
        RETURNING id
        `,
        [id, name, initials, email, password || null]
      );

      if (userResult.rowCount === 0) {
        await query("ROLLBACK");
        return res.status(404).json({ message: "Dosen tidak ditemukan." });
      }

      await query(
        `
        UPDATE lecturers
        SET nip = COALESCE($2, nip),
            departemen = COALESCE($3, departemen),
            jabatan = COALESCE($4, jabatan),
            keahlian = COALESCE($5::text[], keahlian),
            status = COALESCE($6, status),
            updated_at = NOW()
        WHERE id = $1
        `,
        [id, nip, departemen, jabatan, normalizedKeahlian, status]
      );

      await query("COMMIT");
      return res.json({ message: "Data dosen berhasil diperbarui." });
    } catch (error) {
      await query("ROLLBACK");
      const mappedError = mapUniqueConstraintError(error);
      if (mappedError) {
        return res.status(mappedError.status).json({ message: mappedError.message });
      }
      throw error;
    }
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await query("DELETE FROM users WHERE id = $1 AND role = 'dosen' RETURNING id", [req.params.id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Dosen tidak ditemukan." });
    }

    return res.json({ message: "Dosen berhasil dihapus." });
  })
);

module.exports = router;
