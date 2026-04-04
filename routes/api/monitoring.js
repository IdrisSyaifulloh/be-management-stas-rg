const express = require("express");
const asyncHandler = require("../../utils/asyncHandler");
const { query } = require("../../db/pool");

const router = express.Router();

/**
 * GET /api/monitoring/low-activity
 * Returns students who haven't met their weekly attendance target 
 * or monthly logbook target.
 */
router.get(
  "/low-activity",
  asyncHandler(async (req, res) => {
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay()); // Start of week (Sunday)
    startOfWeek.setHours(0, 0, 0, 0);

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // 1. Find students with Low Attendance (Hours < Target)
    // We rely on the cached 'jam_minggu_ini' and 'jam_minggu_target' in students table
    const lowAttendanceQuery = `
      SELECT s.id, s.user_id, u.name, s.nim, u.initials,
             s.jam_minggu_ini as hours_logged, 
             s.jam_minggu_target as hours_target,
             s.status
      FROM students s
      JOIN users u ON u.id = s.user_id
      WHERE s.status = 'Aktif'
        AND s.jam_minggu_ini < s.jam_minggu_target
      ORDER BY s.jam_minggu_ini ASC
    `;

    // 2. Find students with Low Logbook (Count < Target)
    // We count entries in the current month
    const lowLogbookQuery = `
      SELECT s.id, s.user_id, u.name, s.nim, u.initials,
             COUNT(le.id) as logbook_count,
             COALESCE(s.logbook_count, 0) as total_logbook
      FROM students s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN logbook_entries le ON le.student_id = s.id 
        AND le.date >= $1
      WHERE s.status = 'Aktif'
      GROUP BY s.id, u.name, s.nim, u.initials
      HAVING COUNT(le.id) < 4 -- Target 4 logbooks per month
      ORDER BY COUNT(le.id) ASC
    `;

    const [attendanceResult, logbookResult] = await Promise.all([
      query(lowAttendanceQuery),
      query(lowLogbookQuery, [startOfMonth])
    ]);

    res.json({
      timestamp: now.toISOString(),
      lowAttendance: attendanceResult.rows,
      lowLogbook: logbookResult.rows
    });
  })
);

module.exports = router;
