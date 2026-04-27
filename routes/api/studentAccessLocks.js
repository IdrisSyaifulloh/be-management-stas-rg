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
        studentId: student?.id || null,
        studentName: student?.name || null,
        date: null,
        reason: null,
        message: null,
        lockedAt: null
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

    const unlockedBy = req.body?.unlockedBy || req.authUser?.id || req.headers["x-user-id"] || null;
    const lock = await unlockAccessLock({ id: req.params.id, unlockedBy });
    if (!lock) {
      return res.status(404).json({ message: "Access lock tidak ditemukan." });
    }

    res.json(lock);
  })
);

module.exports = router;
