const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { extractRole } = require("../../utils/roleGuard");
const { getSettingsAsync, updateSettings } = require("../../config/systemSettingsStore");

const router = express.Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Akses ditolak." });
    }
    const settings = await getSettingsAsync();
    res.json(settings);
  })
);

router.patch(
  "/",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "operator") {
      return res.status(403).json({ message: "Akses ditolak." });
    }
    const settings = await updateSettings(req.body || {});
    res.json({ message: "Pengaturan sistem berhasil diperbarui.", settings });
  })
);

module.exports = router;
