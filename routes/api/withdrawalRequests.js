const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { buildWhereClause } = require("../../utils/queryFilters");
const { extractRole } = require("../../utils/roleGuard");
const { resolveStudentId } = require("../../utils/studentResolver");
const { createNotification } = require("../../utils/notificationService");

const router = express.Router();

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

async function sendNotification(recipientUserId, title, body, senderUserId = null, type = "pengunduran_diri") {
  await createNotification({
    recipientUserId,
    title,
    body,
    senderUserId,
    type
  });
}

async function writeAuditLog(userId, userRole, action, target, detail) {
  try {
    const auditId = `AL-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    await query(
      `INSERT INTO audit_logs (id, user_id, user_role, action, target, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [auditId, userId || null, userRole, action, target, JSON.stringify(detail)]
    );
  } catch (err) {
    // Audit log failure tidak boleh menghentikan proses utama
    console.error("[WithdrawalRequests] Audit log failed:", err.message);
  }
}

// Query SELECT lengkap untuk semua endpoint yang perlu return rich response
const SELECT_WITHDRAWAL = `
  SELECT
    wr.id,
    wr.student_id,
    s.nim AS student_nim,
    su.name AS student_name,
    wr.advisor_id,
    au.name AS advisor_name,
    wr.reason,
    wr.submitted_at,
    wr.status_operator,
    wr.status_dosen,
    wr.operator_reviewed_at,
    op_u.name AS operator_reviewed_by,
    wr.operator_note,
    wr.advisor_reviewed_at,
    adv_u.name AS advisor_reviewed_by,
    wr.advisor_note,
    wr.final_status,
    wr.created_at,
    wr.updated_at
  FROM withdrawal_requests wr
  JOIN students s ON s.id = wr.student_id
  JOIN users su ON su.id = s.user_id
  LEFT JOIN users au ON au.id = wr.advisor_id
  LEFT JOIN users op_u ON op_u.id = wr.operator_reviewed_by
  LEFT JOIN users adv_u ON adv_u.id = wr.advisor_reviewed_by
`;

// ─────────────────────────────────────────────
// GET /api/v1/withdrawal-requests
// Query params: studentId, advisorId, finalStatus, statusOperator
// ─────────────────────────────────────────────
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { studentId, advisorId, finalStatus, statusOperator } = req.query;

    const resolvedStudentId = studentId ? await resolveStudentId(String(studentId)) : null;
    if (studentId && !resolvedStudentId) {
      return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    }

    const { whereClause, params } = buildWhereClause([
      { value: resolvedStudentId, sql: (i) => `wr.student_id = $${i}` },
      { value: advisorId || null, sql: (i) => `wr.advisor_id = $${i}` },
      { value: finalStatus || null, sql: (i) => `wr.final_status = $${i}` },
      { value: statusOperator || null, sql: (i) => `wr.status_operator = $${i}` },
    ]);

    const result = await query(
      `${SELECT_WITHDRAWAL} ${whereClause} ORDER BY wr.submitted_at DESC`,
      params
    );

    res.json(result.rows);
  })
);

// ─────────────────────────────────────────────
// GET /api/v1/withdrawal-requests/:id
// ─────────────────────────────────────────────
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const result = await query(
      `${SELECT_WITHDRAWAL} WHERE wr.id = $1`,
      [req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Pengajuan pengunduran diri tidak ditemukan." });
    }

    res.json(result.rows[0]);
  })
);

// ─────────────────────────────────────────────
// POST /api/v1/withdrawal-requests
// Hanya mahasiswa. Maksimal 1 request aktif per mahasiswa.
// Body: { studentId, reason }
// ─────────────────────────────────────────────
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "mahasiswa") {
      return res.status(403).json({ message: "Hanya mahasiswa yang dapat mengajukan pengunduran diri." });
    }

    const { studentId, reason } = req.body;

    if (!studentId || !reason || String(reason).trim() === "") {
      return res.status(400).json({ message: "studentId dan reason wajib diisi." });
    }

    const resolvedStudentId = await resolveStudentId(String(studentId));
    if (!resolvedStudentId) {
      return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    }

    // Ambil data mahasiswa
    const studentRow = await query(
      `SELECT s.id, s.status, s.pembimbing, s.user_id, u.name AS student_name
       FROM students s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 LIMIT 1`,
      [resolvedStudentId]
    );

    if (studentRow.rowCount === 0) {
      return res.status(404).json({ message: "Mahasiswa tidak ditemukan." });
    }

    const student = studentRow.rows[0];

    if (["Mengundurkan Diri", "Alumni"].includes(student.status)) {
      return res.status(400).json({
        message: `Mahasiswa dengan status "${student.status}" tidak dapat mengajukan pengunduran diri.`,
      });
    }

    // Cek apakah sudah ada request aktif (belum final)
    const existingActive = await query(
      `SELECT id FROM withdrawal_requests
       WHERE student_id = $1
         AND final_status NOT IN ('Ditolak Operator', 'Ditolak Dosen', 'Disetujui')
       LIMIT 1`,
      [resolvedStudentId]
    );

    if (existingActive.rowCount > 0) {
      return res.status(409).json({
        message: "Anda sudah memiliki pengajuan pengunduran diri yang sedang aktif.",
        existingId: existingActive.rows[0].id,
      });
    }

    // Cari advisor berdasarkan nama pembimbing di tabel users (role = dosen)
    const advisorRow = await query(
      `SELECT u.id FROM users u WHERE u.name = $1 AND u.role = 'dosen' LIMIT 1`,
      [student.pembimbing]
    );
    const advisorId = advisorRow.rows[0]?.id || null;

    // Generate ID
    const wdrId = `WDR-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

    await query(
      `INSERT INTO withdrawal_requests (id, student_id, advisor_id, reason, submitted_at, status_operator, final_status)
       VALUES ($1, $2, $3, $4, NOW(), 'Menunggu', 'Menunggu')`,
      [wdrId, resolvedStudentId, advisorId, String(reason).trim()]
    );

    // Kirim notifikasi ke semua operator aktif
    const operators = await query(`SELECT id FROM users WHERE role = 'operator' AND is_active = TRUE`);
    await Promise.all(
      operators.rows.map((row) =>
        sendNotification(
          row.id,
          "Pengajuan Pengunduran Diri Baru",
          `${student.student_name} mengajukan pengunduran diri. ID Pengajuan: ${wdrId}.`,
          student.user_id,
          "pengunduran_diri"
        )
      )
    );

    await writeAuditLog(student.user_id, "Mahasiswa", "Create", "withdrawal_request", {
      withdrawal_request_id: wdrId,
      student_id: resolvedStudentId,
      reason: String(reason).trim(),
    });

    res.status(201).json({
      message: "Pengajuan pengunduran diri berhasil dibuat.",
      id: wdrId,
    });
  })
);

// ─────────────────────────────────────────────
// PATCH /api/v1/withdrawal-requests/:id/operator-review
// Hanya operator. Hanya bisa memproses jika status_operator = 'Menunggu'.
// Body: { status: 'Diteruskan'|'Ditolak', reviewedById, note }
// ─────────────────────────────────────────────
router.patch(
  "/:id/operator-review",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat memproses tahap ini." });
    }

    const { status, reviewedById, note } = req.body;

    if (!status || !["Diteruskan", "Ditolak"].includes(status)) {
      return res.status(400).json({ message: 'status harus "Diteruskan" atau "Ditolak".' });
    }

    // Ambil data request beserta user_id mahasiswa untuk notifikasi
    const current = await query(
      `SELECT wr.id, wr.status_operator, wr.student_id, wr.advisor_id,
              s.user_id AS student_user_id, su.name AS student_name
       FROM withdrawal_requests wr
       JOIN students s ON s.id = wr.student_id
       JOIN users su ON su.id = s.user_id
       WHERE wr.id = $1 LIMIT 1`,
      [req.params.id]
    );

    if (current.rowCount === 0) {
      return res.status(404).json({ message: "Pengajuan pengunduran diri tidak ditemukan." });
    }

    const wr = current.rows[0];

    if (wr.status_operator !== "Menunggu") {
      return res.status(409).json({ message: "Pengajuan ini sudah pernah diproses oleh operator." });
    }

    const newFinalStatus = status === "Diteruskan" ? "Menunggu Dosen" : "Ditolak Operator";
    const newStatusDosen = status === "Diteruskan" ? "Menunggu" : null;

    await query(
      `UPDATE withdrawal_requests
       SET status_operator       = $2,
           status_dosen          = COALESCE($3, status_dosen),
           operator_reviewed_at  = NOW(),
           operator_reviewed_by  = $4,
           operator_note         = $5,
           final_status          = $6,
           updated_at            = NOW()
       WHERE id = $1`,
      [req.params.id, status, newStatusDosen, reviewedById || null, note || null, newFinalStatus]
    );

    // Notifikasi
    if (status === "Diteruskan") {
      // Beritahu dosen pembimbing
      if (wr.advisor_id) {
        await sendNotification(
          wr.advisor_id,
          "Pengajuan Pengunduran Diri Perlu Ditinjau",
          `Operator telah meneruskan pengajuan pengunduran diri dari ${wr.student_name} (ID: ${req.params.id}) untuk keputusan Anda.`,
          reviewedById || null,
          "pengunduran_diri"
        );
      }
      // Beritahu mahasiswa
      await sendNotification(
        wr.student_user_id,
        "Pengajuan Pengunduran Diri Diteruskan",
        `Pengajuan Anda (ID: ${req.params.id}) telah diteruskan oleh operator ke dosen pembimbing untuk keputusan final.`,
        reviewedById || null,
        "pengunduran_diri"
      );
    } else {
      // Beritahu mahasiswa penolakan operator
      await sendNotification(
        wr.student_user_id,
        "Pengajuan Pengunduran Diri Ditolak Operator",
        `Pengajuan pengunduran diri Anda (ID: ${req.params.id}) telah ditolak oleh operator.${note ? " Catatan: " + note : ""}`,
        reviewedById || null,
        "pengunduran_diri"
      );
    }

    await writeAuditLog(reviewedById || null, "Operator", "Update", "withdrawal_request", {
      withdrawal_request_id: req.params.id,
      status_operator: status,
      final_status: newFinalStatus,
      note: note || null,
    });

    res.json({
      message:
        status === "Diteruskan"
          ? "Pengajuan berhasil diteruskan ke dosen pembimbing."
          : "Pengajuan berhasil ditolak.",
    });
  })
);

// ─────────────────────────────────────────────
// PATCH /api/v1/withdrawal-requests/:id/advisor-review
// Hanya dosen pembimbing yang TERDAFTAR pada pengajuan (advisor_id).
// Sumber identitas: header x-user-id (req.authUser.id) — bukan body reviewedById.
// Body: { status: 'Disetujui'|'Ditolak', reviewedById, note }
//   - reviewedById dipakai sebagai metadata/logging saja, BUKAN untuk otorisasi.
// Jika Disetujui → students.status = 'Mengundurkan Diri' + withdrawal_at + scheduled_deletion_at
// ─────────────────────────────────────────────
router.patch(
  "/:id/advisor-review",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "dosen") {
      return res.status(403).json({ message: "Hanya dosen pembimbing yang dapat memproses tahap ini." });
    }

    // Identitas pemanggil diambil dari header auth (x-user-id), bukan dari body.
    // Body reviewedById hanya dipakai sebagai metadata logging.
    const callerId = req.authUser?.id || null;

    const { status, reviewedById, note } = req.body;

    if (!status || !["Disetujui", "Ditolak"].includes(status)) {
      return res.status(400).json({ message: 'status harus "Disetujui" atau "Ditolak".' });
    }

    // Ambil data request — sertakan advisor_id untuk validasi identitas
    const current = await query(
      `SELECT wr.id, wr.status_operator, wr.status_dosen, wr.student_id, wr.advisor_id,
              s.user_id AS student_user_id, su.name AS student_name
       FROM withdrawal_requests wr
       JOIN students s ON s.id = wr.student_id
       JOIN users su ON su.id = s.user_id
       WHERE wr.id = $1 LIMIT 1`,
      [req.params.id]
    );

    if (current.rowCount === 0) {
      return res.status(404).json({ message: "Pengajuan pengunduran diri tidak ditemukan." });
    }

    const wr = current.rows[0];

    // ── AUTHORIZATION: hanya advisor yang terdaftar pada pengajuan ini ──────
    if (!callerId || callerId !== wr.advisor_id) {
      // Catat percobaan akses tidak sah
      await writeAuditLog(callerId, "Dosen", "Update", "withdrawal_request_unauthorized", {
        withdrawal_request_id: req.params.id,
        caller_id: callerId,
        expected_advisor_id: wr.advisor_id,
        attempted_status: status,
        reason: "Caller is not the assigned advisor for this withdrawal request",
      });
      return res.status(403).json({
        message: "Hanya dosen pembimbing yang ditetapkan pada pengajuan ini yang dapat memberikan keputusan.",
      });
    }
    // ────────────────────────────────────────────────────────────────────────

    if (wr.status_operator !== "Diteruskan") {
      return res.status(409).json({ message: "Pengajuan ini belum diteruskan oleh operator." });
    }

    if (wr.status_dosen !== "Menunggu") {
      return res.status(409).json({ message: "Pengajuan ini sudah pernah diproses oleh dosen." });
    }

    const newFinalStatus = status === "Disetujui" ? "Disetujui" : "Ditolak Dosen";

    // Simpan callerId (dari header) sebagai advisor_reviewed_by — bukan reviewedById dari body
    await query(
      `UPDATE withdrawal_requests
       SET status_dosen          = $2,
           advisor_reviewed_at   = NOW(),
           advisor_reviewed_by   = $3,
           advisor_note          = $4,
           final_status          = $5,
           updated_at            = NOW()
       WHERE id = $1`,
      [req.params.id, status, callerId, note || null, newFinalStatus]
    );

    if (status === "Disetujui") {
      const withdrawalAt = new Date();
      const scheduledDeletionAt = new Date(withdrawalAt.getTime() + 30 * 24 * 60 * 60 * 1000);

      await query(
        `UPDATE students
         SET status                = 'Mengundurkan Diri',
             withdrawal_at         = $2,
             scheduled_deletion_at = $3,
             updated_at            = NOW()
         WHERE id = $1`,
        [wr.student_id, withdrawalAt.toISOString(), scheduledDeletionAt.toISOString()]
      );

      await sendNotification(
        wr.student_user_id,
        "Pengunduran Diri Disetujui",
        `Pengajuan pengunduran diri Anda (ID: ${req.params.id}) telah disetujui oleh dosen pembimbing. Status Anda kini berubah menjadi "Mengundurkan Diri".`,
        callerId,
        "pengunduran_diri"
      );
    } else {
      await sendNotification(
        wr.student_user_id,
        "Pengajuan Pengunduran Diri Ditolak Dosen",
        `Pengajuan pengunduran diri Anda (ID: ${req.params.id}) telah ditolak oleh dosen pembimbing.${note ? " Catatan: " + note : ""}`,
        callerId,
        "pengunduran_diri"
      );
    }

    const auditAction = status === "Disetujui" ? "Approve" : "Update";
    await writeAuditLog(callerId, "Dosen", auditAction, "withdrawal_request", {
      withdrawal_request_id: req.params.id,
      student_id: wr.student_id,
      status_dosen: status,
      final_status: newFinalStatus,
      student_status_updated: status === "Disetujui",
      note: note || null,
    });

    res.json({
      message:
        status === "Disetujui"
          ? "Pengajuan pengunduran diri disetujui. Status mahasiswa telah diperbarui."
          : "Pengajuan pengunduran diri berhasil ditolak.",
      ...(status === "Disetujui" && { studentStatusUpdated: true }),
    });
  })
);

module.exports = router;
