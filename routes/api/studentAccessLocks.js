const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { extractRole } = require("../../utils/roleGuard");
const {
  getActiveLockForStudent,
  listAccessLocks,
  mapAccessLockRow,
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

    const userId = req.authUser?.id || req.headers["x-user-id"];
    const lock = await getActiveLockForStudent(userId);
    if (!lock) {
      const student = await resolveStudentRecord(userId);
      return res.json({
        id: null,
        locked: false,
        active: false,
        status: "UNLOCKED",
        student_id: student?.id || null,
        studentId: student?.id || null,
        student_name: student?.name || null,
        studentName: student?.name || null,
        student_nim: student?.nim || null,
        nim: student?.nim || null,
        reference_date: null,
        date: null,
        lock_reason: null,
        reason: null,
        reason_label: null,
        reasonLabel: null,
        reason_detail: null,
        reasonDetail: null,
        message: null,
        locked_at: null,
        lockedAt: null,
        unlocked_at: null,
        unlockedAt: null,
        unlocked_by: null,
        unlockedBy: null
      });
    }

    res.json(mapAccessLockRow(lock));
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Daftar access lock hanya untuk operator." });
    }

    res.json(await listAccessLocks({ status: req.query.status }));
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
    const unlockedBy = req.body?.unlockedBy || req.authUser?.id || req.headers["x-user-id"] || null;
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
    const unlockedBy = req.body?.unlockedBy || req.authUser?.id || req.headers["x-user-id"] || null;
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
