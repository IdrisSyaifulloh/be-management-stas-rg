const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { extractRole } = require("../../utils/roleGuard");
const {
  getWfhStudentSettings,
  saveWfhStudentSettings,
} = require("../../utils/wfhStudentSettings");

const router = express.Router();

router.get(
  "/students",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Akses ditolak." });
    }
    const items = await getWfhStudentSettings();
    res.json({ items });
  })
);

router.patch(
  "/students",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Akses ditolak." });
    }

    const payload = Array.isArray(req.body)
      ? req.body
      : req.body?.items || [];

    const items = await saveWfhStudentSettings(payload);

    res.json({
      message: "Pengaturan WFH per mahasiswa berhasil diperbarui.",
      items,
    });
  })
);

module.exports = router;