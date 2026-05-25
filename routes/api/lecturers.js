const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const bcrypt = require("bcrypt");

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

function normalizeOptionalText(input) {
  if (input === undefined || input === null) return null;
  const value = String(input).trim();
  return value || null;
}

function mapUniqueConstraintError(error) {
  if (!error || error.code !== "23505") return null;

  if (error.constraint === "users_email_key") {
    return { status: 409, message: "Email sudah digunakan oleh akun lain." };
  }

  if (error.constraint === "lecturers_nip_key") {
    return { status: 409, message: "NIP sudah terdaftar." };
  }

  if (error.constraint === "lecturers_nidn_key") {
    return { status: 409, message: "NIDN sudah terdaftar." };
  }

  if (error.constraint === "lecturers_kode_dosen_key") {
    return { status: 409, message: "Kode dosen sudah terdaftar." };
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
      SELECT l.id, l.user_id, l.kode_dosen, l.nip, l.nidn,
             l.asal_kampus, l.pendidikan_terakhir, l.kategori_dosen,
             u.name, u.initials, u.email,
             l.departemen, COALESCE(l.jfa, l.jabatan) AS jfa,
             COALESCE(l.jfa, l.jabatan) AS jabatan, l.keahlian,
             l.riset_dipimpin, l.riset_diikuti,
             l.status, l.bergabung, l.mahasiswa_count
      FROM lecturers l
      JOIN users u ON u.id = l.user_id
      ORDER BY u.name ASC
      LIMIT 500
      `
    );

    res.json(result.rows);
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const {
      id,
      nip,
      name,
      initials,
      email,
      kode_dosen,
      nidn,
      asal_kampus,
      pendidikan_terakhir,
      kategori_dosen,
      departemen,
      jabatan,
      jfa,
      keahlian,
      status,
      password
    } = req.body;
    const normalizedKeahlian = normalizeKeahlian(keahlian);
    const normalizedJfa = normalizeOptionalText(jfa ?? jabatan);

    if (!id || !nip || !name || !initials || !status || !password) {
      return res.status(400).json({ message: "id, nip, name, initials, status, password wajib diisi." });
    }

    await query("BEGIN");
    try {
      const passwordHash = await bcrypt.hash(password, 10);
      await query(
        `
        INSERT INTO users (id, name, initials, role, email, password_hash)
        VALUES ($1, $2, $3, 'dosen', $4, $5)
        `,
        [id, name, initials, email || null, passwordHash]
      );

      await query(
        `
        INSERT INTO lecturers (
          id, user_id, kode_dosen, nip, nidn, asal_kampus,
          pendidikan_terakhir, kategori_dosen, departemen,
          jabatan, jfa, keahlian, status
        )
        VALUES (
          $1, $1, $2, $3, $4, $5,
          $6, $7, $8,
          $9, $10, COALESCE($11::text[], '{}'::text[]), $12
        )
        `,
        [
          id,
          normalizeOptionalText(kode_dosen),
          nip,
          normalizeOptionalText(nidn),
          normalizeOptionalText(asal_kampus),
          normalizeOptionalText(pendidikan_terakhir),
          normalizeOptionalText(kategori_dosen),
          normalizeOptionalText(departemen),
          normalizedJfa,
          normalizedJfa,
          normalizedKeahlian,
          status
        ]
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
    const requestedId = req.params.id;
    const {
      nip,
      name,
      initials,
      email,
      kode_dosen,
      nidn,
      asal_kampus,
      pendidikan_terakhir,
      kategori_dosen,
      departemen,
      jabatan,
      jfa,
      keahlian,
      status,
      password
    } = req.body;
    const normalizedKeahlian = keahlian === undefined ? undefined : normalizeKeahlian(keahlian);
    const normalizedJfa = jfa === undefined && jabatan === undefined
      ? undefined
      : normalizeOptionalText(jfa ?? jabatan);

    await query("BEGIN");
    try {
      const lecturerLookup = await query(
        `
        SELECT id, user_id
        FROM lecturers
        WHERE id = $1 OR user_id = $1
        LIMIT 1
        `,
        [requestedId]
      );

      if (lecturerLookup.rowCount === 0) {
        await query("ROLLBACK");
        return res.status(404).json({ message: "Dosen tidak ditemukan." });
      }

      const lecturerId = lecturerLookup.rows[0].id;
      const userId = lecturerLookup.rows[0].user_id;

      let passwordHash = null;
      if (password && String(password).trim() !== "") {
        passwordHash = await bcrypt.hash(password, 10);
      }

      await query(
        `
        UPDATE users
        SET name = COALESCE($2, name),
            initials = COALESCE($3, initials),
            email = COALESCE($4, email),
            password_hash = COALESCE($5, password_hash),
            updated_at = NOW()
        WHERE id = $1 AND role = 'dosen'
        `,
        [userId, name, initials, email, passwordHash]
      );

      await query(
        `
        UPDATE lecturers
        SET kode_dosen = COALESCE($2, kode_dosen),
            nip = COALESCE($3, nip),
            nidn = COALESCE($4, nidn),
            asal_kampus = COALESCE($5, asal_kampus),
            pendidikan_terakhir = COALESCE($6, pendidikan_terakhir),
            kategori_dosen = COALESCE($7, kategori_dosen),
            departemen = COALESCE($8, departemen),
            jabatan = COALESCE($9, jabatan),
            jfa = COALESCE($10, jfa),
            keahlian = COALESCE($11::text[], keahlian),
            status = COALESCE($12, status),
            updated_at = NOW()
        WHERE id = $1
        `,
        [
          lecturerId,
          normalizeOptionalText(kode_dosen),
          nip,
          normalizeOptionalText(nidn),
          normalizeOptionalText(asal_kampus),
          normalizeOptionalText(pendidikan_terakhir),
          normalizeOptionalText(kategori_dosen),
          normalizeOptionalText(departemen),
          normalizedJfa,
          normalizedJfa,
          normalizedKeahlian,
          status
        ]
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
    let result = await query(
      "DELETE FROM users WHERE id = $1 AND role = 'dosen' RETURNING id",
      [req.params.id]
    );

    if (result.rowCount === 0) {
      const lecturerCheck = await query(
        "SELECT user_id FROM lecturers WHERE id = $1",
        [req.params.id]
      );
      if (lecturerCheck.rowCount > 0) {
        result = await query(
          "DELETE FROM users WHERE id = $1 AND role = 'dosen' RETURNING id",
          [lecturerCheck.rows[0].user_id]
        );
      }
    }

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Dosen tidak ditemukan." });
    }

    return res.json({ message: "Dosen berhasil dihapus." });
  })
);

module.exports = router;
