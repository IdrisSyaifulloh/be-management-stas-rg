const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { getSettingsAsync, updateSettings } = require("../../config/systemSettingsStore");
const {
  deactivateAttendanceAbsentLocksForConfiguredHolidays
} = require("../../utils/studentAccessLocks");

const router = express.Router();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const settings = await getSettingsAsync();
    res.json(settings);
  })
);

router.patch(
  "/",
  asyncHandler(async (req, res) => {
    const settings = await updateSettings(req.body || {});
    const deactivatedAttendanceAbsentLockIds =
      await deactivateAttendanceAbsentLocksForConfiguredHolidays(settings);

    res.json({
      message: "Pengaturan sistem berhasil diperbarui.",
      settings,
      deactivatedAttendanceAbsentLockIds
    });
  })
);

module.exports = router;
