const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { extractRole } = require("../../utils/roleGuard");
const {
  getActiveLockForStudent,
  listAccessLocks,
  mapAccessLockRow,
  createStudentAccessLocks,
  ACCESS_LOCK_REASON_PICKET_SUBMISSION_INVALID,
  ACCESS_LOCK_REASON_PICKET_SUBMISSION_MISSING,
  unlockAccessLock
} = require("../../utils/studentAccessLocks");
const { resolveStudentRecord } = require("../../utils/studentResolver");
const { requireSafeId } = require("../../utils/securityValidation");

const router = express.Router();

router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "mahasiswa") {
      return res.status(403).json({ message: "Endpoint lock saya hanya untuk mahasiswa." });
    }

    const userId = req.authUser?.id;
    const lock = await getActiveLockForStudent(userId);
    if (!lock) {
      return res.json({
        locked: false,
        reason: null,
        reasonLabel: null,
        reasonDetail: null,
        message: null,
        date: null
      });
    }

    const mapped = mapAccessLockRow(lock);
    res.json({
      locked: true,
      reason: mapped.reason,
      reasonLabel: mapped.reasonLabel,
      reasonDetail: mapped.reasonDetail,
      message: mapped.message,
      date: mapped.date
    });
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Daftar access lock hanya untuk operator." });
    }

    res.json(await listAccessLocks({ status: req.query.status, search: req.query.search || req.query.q }));
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Membuat access lock hanya untuk operator." });
    }

    const studentId = requireSafeId(req.body?.studentId || req.body?.student_id, "studentId");
    const reason = String(req.body?.reason || "").trim();
    const date = String(req.body?.date || req.body?.lockDate || req.body?.lock_date || "")
      .trim()
      .slice(0, 10);

    if (
      reason !== ACCESS_LOCK_REASON_PICKET_SUBMISSION_INVALID &&
      reason !== ACCESS_LOCK_REASON_PICKET_SUBMISSION_MISSING
    ) {
      return res.status(400).json({ message: "reason tidak didukung untuk endpoint ini." });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: "date wajib format YYYY-MM-DD." });
    }

    const ids = await createStudentAccessLocks({
      studentIds: [studentId],
      date,
      reason
    });

    res.status(201).json({
      message: ids.length > 0 ? "Access lock berhasil dibuat." : "Access lock sudah aktif atau sudah ada.",
      ids,
      reason,
      studentId,
      date
    });
  })
);

router.patch(
  "/:id/unlock",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Unlock access lock hanya untuk operator." });
    }

    const id = requireSafeId(req.params.id, "id");
    const unlockedBy = req.authUser?.id || null;
    const lock = await unlockAccessLock({ id, unlockedBy });
    if (!lock) {
      return res.status(404).json({ message: "Access lock tidak ditemukan." });
    }

    res.json(lock);
  })
);

router.post(
  "/unlock",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Unlock access lock hanya untuk operator." });
    }

    const studentId = requireSafeId(req.body?.studentId || req.body?.student_id, "studentId");
    const unlockedBy = req.authUser?.id || null;
    const activeLock = await getActiveLockForStudent(studentId);
    if (!activeLock) {
      return res.status(404).json({ message: "Access lock aktif tidak ditemukan." });
    }

    const lock = await unlockAccessLock({ id: activeLock.id, unlockedBy });
    if (!lock) {
      return res.status(404).json({ message: "Access lock tidak ditemukan." });
    }

    res.json(lock);
  })
);

module.exports = router;
