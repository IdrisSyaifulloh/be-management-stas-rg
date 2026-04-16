const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { buildWhereClause } = require("../../utils/queryFilters");
const { extractRole } = require("../../utils/roleGuard");

const router = express.Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    let studentId = role === "mahasiswa" ? req.authUser?.id : req.query.studentId;
    const { projectId } = req.query;

    // Resolve studentId if it's actually a user_id
    if (studentId) {
      const studentCheck = await query("SELECT id FROM students WHERE id = $1 OR user_id = $1 LIMIT 1", [studentId]);
      if (studentCheck.rowCount > 0) {
        studentId = studentCheck.rows[0].id;
      }
    }

    const { whereClause, params } = buildWhereClause([
      { value: studentId, sql: (index) => `le.student_id = $${index}` },
      { value: projectId, sql: (index) => `le.project_id = $${index}` }
    ]);

    const result = await query(
      `
      SELECT le.id, le.student_id, su.name AS student_name, su.initials AS student_initials,
             le.project_id, rp.short_title AS project_name,
             le.date, le.title, le.description, le.output, le.kendala, le.has_attachment,
             COALESCE(lc.comments, '[]'::json) AS comments,
             COALESCE(lc.comments_count, 0) AS comments_count,
             lv.detail->>'verificationStatus' AS verification_status,
             lv.detail->>'verificationNote' AS verification_note,
             vu.name AS verified_by_name,
             lv.logged_at AS verified_at
      FROM logbook_entries le
      JOIN students s ON s.id = le.student_id
      JOIN users su ON su.id = s.user_id
      LEFT JOIN research_projects rp ON rp.id = le.project_id
      LEFT JOIN LATERAL (
        SELECT
          json_agg(
            json_build_object(
              'id', lcm.id,
              'authorId', lcm.author_id,
              'authorName', COALESCE(lcm.author_name, au.name),
              'text', lcm.text,
              'createdAt', lcm.created_at
            )
            ORDER BY lcm.created_at DESC
          ) AS comments,
          COUNT(*)::int AS comments_count
        FROM logbook_comments lcm
        LEFT JOIN users au ON au.id = lcm.author_id
        WHERE lcm.logbook_entry_id = le.id
      ) lc ON TRUE
      LEFT JOIN LATERAL (
        SELECT al.user_id, al.detail, al.logged_at
        FROM audit_logs al
        WHERE al.target = 'Logbook'
          AND (al.detail->>'logbookId') = le.id
          AND al.detail ? 'verificationStatus'
        ORDER BY al.logged_at DESC
        LIMIT 1
      ) lv ON TRUE
      LEFT JOIN users vu ON vu.id = lv.user_id
      ${whereClause}
      ORDER BY le.date DESC, le.id DESC
      `,
      params
    );

    res.json(result.rows);
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "mahasiswa") {
      return res.status(403).json({ message: "Hanya mahasiswa yang dapat menambah logbook." });
    }

    const {
      id,
      studentId,
      projectId,
      date,
      title,
      description,
      output,
      kendala,
      hasAttachment
    } = req.body;

    if (!id || !studentId || !date || !title || !description) {
      return res.status(400).json({ message: "id, studentId, date, title, description wajib diisi." });
    }

    // Validate against logged-in user (frontend sends user_id as studentId)
    if (String(studentId) !== String(req.authUser?.id)) {
      return res.status(403).json({ message: "studentId tidak sesuai akun login." });
    }

    // Resolve student_id: check if studentId is actually a user_id and find the real student.id
    let resolvedStudentId = studentId;
    const studentCheck = await query("SELECT id FROM students WHERE id = $1 OR user_id = $1 LIMIT 1", [studentId]);
    if (studentCheck.rowCount > 0) {
      resolvedStudentId = studentCheck.rows[0].id;
    } else {
      return res.status(404).json({ message: "Data mahasiswa tidak ditemukan." });
    }

    await query(
      `
      INSERT INTO logbook_entries (
        id, student_id, project_id, date, title, description, output, kendala, has_attachment
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `,
      [id, resolvedStudentId, projectId || null, date, title, description, output || null, kendala || null, Boolean(hasAttachment)]
    );

    res.status(201).json({ message: "Entri logbook berhasil ditambahkan." });
  })
);

router.patch(
  "/:id/verify",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (!["operator", "dosen"].includes(role)) {
      return res.status(403).json({ message: "Hanya dosen/operator yang dapat memverifikasi logbook." });
    }

    const { verificationStatus, verificationNote, verifiedBy, verifiedByName } = req.body;

    if (!verificationStatus || !["Terverifikasi", "Perlu Revisi"].includes(verificationStatus)) {
      return res.status(400).json({ message: "verificationStatus harus Terverifikasi/Perlu Revisi." });
    }

    if (!verifiedBy) {
      return res.status(400).json({ message: "verifiedBy wajib diisi." });
    }

    const exists = await query("SELECT id FROM logbook_entries WHERE id = $1", [req.params.id]);
    if (exists.rowCount === 0) {
      return res.status(404).json({ message: "Entri logbook tidak ditemukan." });
    }

    const auditId = `AL-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const roleLabel = role === "dosen" ? "Dosen" : "Operator";
    await query(
      `
      INSERT INTO audit_logs (id, user_id, user_role, action, target, ip, detail)
      VALUES ($1, $2, $3, 'Approve', 'Logbook', $4, $5)
      `,
      [
        auditId,
        verifiedBy,
        roleLabel,
        req.ip || null,
        {
          logbookId: req.params.id,
          verificationStatus,
          verificationNote: verificationNote || null,
          verifiedByName: verifiedByName || null
        }
      ]
    );

    res.json({ message: "Verifikasi logbook berhasil disimpan." });
  })
);

router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const { projectId, date, title, description, output, kendala, hasAttachment } = req.body;

    const result = await query(
      `
      UPDATE logbook_entries
      SET project_id = COALESCE($2, project_id),
          date = COALESCE($3, date),
          title = COALESCE($4, title),
          description = COALESCE($5, description),
          output = COALESCE($6, output),
          kendala = COALESCE($7, kendala),
          has_attachment = COALESCE($8, has_attachment),
          updated_at = NOW()
      WHERE id = $1
      RETURNING id
      `,
      [req.params.id, projectId, date, title, description, output, kendala, hasAttachment]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Entri logbook tidak ditemukan." });
    }

    res.json({ message: "Entri logbook berhasil diperbarui." });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await query("DELETE FROM logbook_entries WHERE id = $1 RETURNING id", [req.params.id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Entri logbook tidak ditemukan." });
    }

    res.json({ message: "Entri logbook berhasil dihapus." });
  })
);

router.post(
  "/:id/comments",
  asyncHandler(async (req, res) => {
    const { id, logbookId, authorId, authorName, text } = req.body;

    if (!id || !logbookId || !authorId || !text) {
      return res.status(400).json({ message: "id, logbookId, authorId, text wajib diisi." });
    }

    await query(
      `
      INSERT INTO logbook_comments (id, logbook_entry_id, author_id, author_name, text)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [id, logbookId, authorId, authorName || null, text]
    );

    res.status(201).json({ message: "Komentar berhasil ditambahkan." });
  })
);

router.delete(
  "/:logbookId/comments/:commentId",
  asyncHandler(async (req, res) => {
    const { logbookId, commentId } = req.params;

    // Verify the comment belongs to the specified logbook entry
    const commentCheck = await query(
      "SELECT id FROM logbook_comments WHERE id = $1 AND logbook_entry_id = $2",
      [commentId, logbookId]
    );

    if (commentCheck.rowCount === 0) {
      return res.status(404).json({ message: "Komentar tidak ditemukan." });
    }

    await query("DELETE FROM logbook_comments WHERE id = $1", [commentId]);

    res.json({ message: "Komentar berhasil dihapus." });
  })
);

module.exports = router;
