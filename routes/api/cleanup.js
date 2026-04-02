/**
 * Cleanup Jobs API
 * 
 * Manual endpoints to trigger system cleanup jobs
 */

const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { runCleanup } = require("../../jobs/cleanupWithdrawnStudents");

const router = express.Router();

/**
 * POST /api/cleanup/withdrawn-students
 * Manually trigger cleanup of withdrawn student accounts
 */
router.post(
  "/withdrawn-students",
  asyncHandler(async (req, res) => {
    const result = await runCleanup();
    return res.json({
      message: "Cleanup job completed successfully.",
      deleted_count: result.deleted,
      deleted_accounts: result.accounts
    });
  })
);

module.exports = router;
