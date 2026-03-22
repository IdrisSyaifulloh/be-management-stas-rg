const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");
const { getSettingsAsync } = require("../../config/systemSettingsStore");

const router = express.Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const dbResult = await query("SELECT NOW() AS now");
    res.json({
      ok: true,
      service: "be-managementstas",
      time: dbResult.rows[0].now
    });
  })
);

router.get(
  "/branding",
  asyncHandler(async (_req, res) => {
    const settings = await getSettingsAsync();
    res.json({
      appName: settings?.umum?.appName || "STAS-RG MS",
      universityName: settings?.umum?.universityName || "Telkom University",
      logoDataUrl: settings?.umum?.logoDataUrl || null
    });
  })
);

router.get(
  "/leave-rules",
  asyncHandler(async (_req, res) => {
    const settings = await getSettingsAsync();
    res.json({
      maxSemesterDays: Number(settings?.cuti?.maxSemesterDays || 0),
      maxMonthDays: Number(settings?.cuti?.maxMonthDays || 0),
      minAttendancePct: Number(settings?.cuti?.minAttendancePct || 0),
      period: settings?.cuti?.period || ""
    });
  })
);

module.exports = router;
