const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");

const router = express.Router();

const DRAFT_TYPES = ["Laporan TA", "Jurnal", "Laporan Kemajuan"];
const DRAFT_STATUSES = ["Menunggu Review", "Dalam Review", "Disetujui"];

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { studentId, type = "Semua" } = req.query;
    if (!studentId) {
      return res.status(400).json({ message: "studentId wajib diisi." });
    }

    const result = await query(
      `
      SELECT le.id, le.student_id, su.name AS student_name, le.title, le.date, rp.short_title AS riset
      FROM logbook_entries le
      JOIN students s ON s.id = le.student_id
      JOIN users su ON su.id = s.user_id
      LEFT JOIN research_projects rp ON rp.id = le.project_id
      WHERE le.student_id = $1
      ORDER BY le.date DESC, le.id DESC
      LIMIT 30
      `,
      [studentId]
    );

    const reviewResult = await query(
      `
      SELECT al.detail->>'draftId' AS draft_id,
             al.detail->>'status' AS status,
             al.detail->>'note' AS note,
             al.detail->>'reviewedByName' AS reviewed_by_name,
             al.logged_at
      FROM audit_logs al
      WHERE al.target = 'DraftReport'
        AND (al.detail->>'studentId') = $1
      ORDER BY al.logged_at DESC
      `,
      [studentId]
    );

    const latestReviewByDraft = new Map();
    reviewResult.rows.forEach((row) => {
      if (!latestReviewByDraft.has(row.draft_id)) {
        latestReviewByDraft.set(row.draft_id, row);
      }
    });

    let rows = result.rows.map((item, index) => {
      const draftType = DRAFT_TYPES[index % DRAFT_TYPES.length];
      const status = DRAFT_STATUSES[index % DRAFT_STATUSES.length];
      const draftId = `D-${item.id}`;
      const reviewed = latestReviewByDraft.get(draftId);
      return {
        id: draftId,
        studentId: item.student_id,
        studentName: item.student_name,
        title: item.title,
        type: draftType,
        uploadDate: new Date(item.date).toLocaleDateString("id-ID"),
        fileSize: `${(1.2 + (index % 5) * 0.6).toFixed(1)} MB`,
        format: "PDF",
        status: reviewed?.status || status,
        comment:
          reviewed?.note ||
          (status === "Disetujui"
            ? "Dokumen sudah memenuhi ketentuan dan siap dipublikasikan."
            : status === "Dalam Review"
              ? "Sedang ditinjau dosen pembimbing."
              : undefined),
        riset: item.riset || "Riset",
        version: `v${1 + (index % 3)}.${index % 10}`,
        reviewedBy: reviewed?.reviewed_by_name,
        reviewedAt: reviewed?.logged_at
      };
    });

    if (type !== "Semua") {
      rows = rows.filter((item) => item.type === type);
    }

    res.json(rows);
  })
);

router.patch(
  "/:id/review",
  asyncHandler(async (req, res) => {
    const { status, note, reviewedBy, reviewedByName, studentId } = req.body;

    if (!status || !DRAFT_STATUSES.includes(status)) {
      return res.status(400).json({ message: "status review tidak valid." });
    }

    if (!reviewedBy || !studentId) {
      return res.status(400).json({ message: "reviewedBy dan studentId wajib diisi." });
    }

    const auditId = `AL-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    await query(
      `
      INSERT INTO audit_logs (id, user_id, user_role, action, target, ip, detail)
      VALUES ($1, $2, 'Dosen', 'Update', 'DraftReport', $3, $4)
      `,
      [
        auditId,
        reviewedBy,
        req.ip || null,
        {
          draftId: req.params.id,
          studentId,
          status,
          note: note || null,
          reviewedByName: reviewedByName || null
        }
      ]
    );

    res.json({ message: "Review draft berhasil disimpan." });
  })
);

module.exports = router;
