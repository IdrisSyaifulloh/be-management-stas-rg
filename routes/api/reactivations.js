const express = require("express");
const crypto = require("crypto");
const asyncHandler = require("../../utils/asyncHandler");
const { pool, query } = require("../../db/pool");
const { createNotification } = require("../../utils/notificationService");
const { ensureGraduationSubmissionsTables } = require("../../utils/graduationSubmissions");

const router = express.Router();

router.use(asyncHandler(async (req, res, next) => {
  await ensureGraduationSubmissionsTables();
  next();
}));

function requireMahasiswa(req, res) {
  if (req.authUser?.role !== "mahasiswa") {
    res.status(403).json({ message: "Akses hanya untuk mahasiswa." });
    return false;
  }
  return true;
}

function requireOperator(req, res) {
  if (!["operator", "admin"].includes(req.authUser?.role)) {
    res.status(403).json({ message: "Akses hanya untuk admin/operator." });
    return false;
  }
  return true;
}

async function getStudentByUserId(userId) {
  const result = await query(
    `
    SELECT s.*, u.name
    FROM students s
    JOIN users u ON u.id = s.user_id
    WHERE s.user_id = $1
    LIMIT 1
    `,
    [userId]
  );
  return result.rows[0] || null;
}

// 1. Alumni Request Reactivation
router.get("/me/projects", asyncHandler(async (req, res) => {
  if (!requireMahasiswa(req, res)) return;

  const result = await query(
    `
    SELECT rp.id, COALESCE(rp.short_title, rp.title) AS title, rp.status
    FROM research_memberships rm
    JOIN research_projects rp ON rp.id = rm.project_id
    WHERE rm.user_id = $1
    ORDER BY rp.created_at DESC
    `,
    [req.authUser.id]
  );

  res.json(result.rows);
}));

// 2. Alumni Submit Reactivation Request
router.post("/me/request", asyncHandler(async (req, res) => {
  if (!requireMahasiswa(req, res)) return;

  const student = await getStudentByUserId(req.authUser.id);
  if (!student) {
    return res.status(404).json({ message: "Data mahasiswa tidak ditemukan." });
  }

  if (student.status !== "Alumni") {
    return res.status(400).json({ message: "Hanya Alumni yang dapat mengajukan reaktivasi riset." });
  }

  // Cek apakah pengajuan dengan project ini masih pending
  const pendingCheck = await query(
    `SELECT id FROM reactivation_requests WHERE student_id = $1 AND status = 'Menunggu'`,
    [student.id]
  );

  if (pendingCheck.rowCount > 0) {
    return res.status(400).json({ message: "Anda sudah memiliki pengajuan reaktivasi yang sedang aktif." });
  }

  const requestId = `RREQ-${crypto.randomUUID()}`;
  await query(
    `
    INSERT INTO reactivation_requests (id, student_id, user_id, status)
    VALUES ($1, $2, $3, 'Menunggu')
    `,
    [requestId, student.id, req.authUser.id]
  );

  res.status(201).json({ message: "Pengajuan reaktivasi riset berhasil dikirim. Menunggu persetujuan admin." });
}));

// 2. Get All Reactivations for Operator
router.get("/", asyncHandler(async (req, res) => {
  if (!requireOperator(req, res)) return;

  const result = await query(
    `
    SELECT r.*, u.name as student_name, s.nim
    FROM reactivation_requests r
    JOIN users u ON u.id = r.user_id
    JOIN students s ON s.id = r.student_id
    ORDER BY r.created_at DESC
    LIMIT 200
    `
  );

  res.json(result.rows.map(r => ({
    id: r.id,
    studentId: r.student_id,
    userId: r.user_id,
    studentName: r.student_name,
    nim: r.nim,
    status: r.status,
    note: r.note,
    createdAt: r.created_at
  })));
}));

// 3. Approve Reactivation
router.post("/:id/approve", asyncHandler(async (req, res) => {
  if (!requireOperator(req, res)) return;

  const requestId = req.params.id;
  
  const client = await pool.connect();
  let studentUserId = null;

  try {
    await client.query("BEGIN");

    const reqResult = await client.query(
      `SELECT * FROM reactivation_requests WHERE id = $1 FOR UPDATE`,
      [requestId]
    );

    if (reqResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Pengajuan tidak ditemukan." });
    }

    const request = reqResult.rows[0];
    if (request.status !== "Menunggu") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Pengajuan ini sudah diproses." });
    }

    studentUserId = request.user_id;

    // Approve
    await client.query(
      `UPDATE reactivation_requests SET status = 'Disetujui', reviewed_by = $1, reviewed_at = NOW() WHERE id = $2`,
      [req.authUser.id, requestId]
    );

    // Update Student to Aktif
    await client.query(
      `UPDATE students SET status = 'Aktif', updated_at = NOW() WHERE id = $1`,
      [request.student_id]
    );

    // Archive previous graduation submissions
    await client.query(
      `UPDATE graduation_submissions SET is_archived = TRUE WHERE student_id = $1`,
      [request.student_id]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (studentUserId) {
    await createNotification({
      recipientUserId: studentUserId,
      senderUserId: req.authUser.id,
      type: "sistem",
      title: "Reaktivasi Riset Disetujui",
      body: "Pengajuan lanjut riset Anda telah disetujui. Akun Anda kembali aktif sebagai Mahasiswa.",
      eventId: `reactivation_approve:${requestId}:${Date.now()}`
    }).catch(() => null);
  }

  res.json({ message: "Pengajuan reaktivasi disetujui." });
}));

// 4. Reject Reactivation
router.post("/:id/reject", asyncHandler(async (req, res) => {
  if (!requireOperator(req, res)) return;

  const requestId = req.params.id;
  const { note } = req.body;
  
  const client = await pool.connect();
  let studentUserId = null;

  try {
    await client.query("BEGIN");

    const reqResult = await client.query(
      `SELECT * FROM reactivation_requests WHERE id = $1 FOR UPDATE`,
      [requestId]
    );

    if (reqResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Pengajuan tidak ditemukan." });
    }

    const request = reqResult.rows[0];
    if (request.status !== "Menunggu") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Pengajuan ini sudah diproses." });
    }

    studentUserId = request.user_id;

    // Reject
    await client.query(
      `UPDATE reactivation_requests SET status = 'Ditolak', note = $1, reviewed_by = $2, reviewed_at = NOW() WHERE id = $3`,
      [note || "Ditolak oleh admin", req.authUser.id, requestId]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (studentUserId) {
    await createNotification({
      recipientUserId: studentUserId,
      senderUserId: req.authUser.id,
      type: "sistem",
      title: "Reaktivasi Riset Ditolak",
      body: `Pengajuan lanjut riset Anda ditolak. Alasan: ${note || "-"}`,
      eventId: `reactivation_reject:${requestId}:${Date.now()}`
    }).catch(() => null);
  }

  res.json({ message: "Pengajuan reaktivasi ditolak." });
}));

module.exports = router;
