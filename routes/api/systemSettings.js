const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { extractRole } = require("../../utils/roleGuard");
const { getSettingsAsync, updateSettings } = require("../../config/systemSettingsStore");

const router = express.Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    const settings = await getSettingsAsync();

    // Operator dapat semua settings
    if (role === "operator") {
      return res.json(settings);
    }

    // Publik (termasuk halaman login) hanya dapat data branding
    const umum = settings?.umum || {};
    return res.json({
      umum: {
        appName: umum.appName || null,
        universityName: umum.universityName || null,
        logoDataUrl: umum.logoDataUrl || null
      }
    });
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
