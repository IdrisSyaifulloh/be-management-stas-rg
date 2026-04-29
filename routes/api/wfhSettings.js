const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const {
  getWfhStudentSettings,
  saveWfhStudentSettings,
} = require("../../utils/wfhStudentSettings");

const router = express.Router();

router.get(
  "/students",
  asyncHandler(async (req, res) => {
    const items = await getWfhStudentSettings();

    res.json({
      items,
    });
  })
);

router.patch("/students", async (req, res) => {
  try {
    console.log("[WFH SETTINGS] PATCH body:", JSON.stringify(req.body, null, 2));

    const payload = Array.isArray(req.body)
      ? req.body
      : req.body?.items || [];

    const items = await saveWfhStudentSettings(payload);

    res.json({
      message: "Pengaturan WFH per mahasiswa berhasil diperbarui.",
      items,
    });
  } catch (err) {
    console.error("[WFH SETTINGS] PATCH ERROR:", err);

    res.status(500).json({
      message: err.message || "Terjadi kesalahan pada server.",
    });
  }
});

module.exports = router;