const { query } = require("../db/pool");
const { getSettingsAsync } = require("../config/systemSettingsStore");
const {
  ACCESS_LOCK_REASON_RESEARCH_WEEKLY_LOW_HOURS,
  createStudentAccessLocks
} = require("../utils/studentAccessLocks");
const { getPreviousJakartaWeekBounds, shiftToJakarta } = require("../utils/jakartaWeek");

const ONE_HOUR = 60 * 60 * 1000;
const DEFAULT_TARGET_HOURS = 8;

// Run on Monday 00:00–02:59 Jakarta time to evaluate the week that just ended (Mon–Sun).
function isEvaluationWindow(date = new Date()) {
  const jakarta = shiftToJakarta(date);
  const dayOfWeek = jakarta.getUTCDay(); // 0=Sun, 1=Mon
  const hour = jakarta.getUTCHours();
  return dayOfWeek === 1 && hour < 3;
}

async function fetchResearchStudentsBelowTarget(targetHours, weekStart, weekEnd) {
  // Count actual hours from attendance_records for the completed week (Mon–Sun).
  // Only suspend students whose real logged hours for that week are below the target.
  const result = await query(
    `
    SELECT s.id AS student_id,
           s.user_id,
           u.name AS student_name,
           u.initials AS student_initials,
           s.nim,
           COALESCE(week_hours.total_hours, 0) AS current_hours,
           $1::int AS target_hours
    FROM students s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN (
      SELECT ar.student_id,
             SUM(
               EXTRACT(EPOCH FROM (
                 COALESCE(ar.check_out_at, ar.check_in_at) - ar.check_in_at
               )) / 3600.0
             ) AS total_hours
      FROM attendance_records ar
      WHERE ar.attendance_date BETWEEN $2::date AND $3::date
        AND ar.check_in_at IS NOT NULL
        AND ar.status IN ('Hadir', 'WFH')
      GROUP BY ar.student_id
    ) week_hours ON week_hours.student_id = s.id
    WHERE s.status = 'Aktif'
      AND s.tipe = 'Riset'
      AND u.is_active = TRUE
      AND COALESCE(week_hours.total_hours, 0) < $1::int
    ORDER BY COALESCE(week_hours.total_hours, 0) ASC, u.name ASC
    `,
    [targetHours, weekStart, weekEnd]
  );

  return result.rows;
}

async function runWeeklyResearchAttendanceSuspensionCycle(now = new Date()) {
  const settings = await getSettingsAsync();
  const attendanceRules = settings?.attendanceRules || {};

  // Default to 8 hours if not configured
  const targetHours = Number(attendanceRules.risetTargetWeeklyHours || DEFAULT_TARGET_HOURS);

  // Evaluate the previous week (the one that just ended)
  const prevWeek = getPreviousJakartaWeekBounds(now);
  const weekStart = prevWeek.startDate;
  const weekEnd = prevWeek.endDate;

  if (targetHours <= 0) {
    return {
      ran: false,
      reason: "disabled_or_no_target",
      weekStart,
      weekEnd,
      targetHours,
      matched: 0,
      locked: 0,
      students: []
    };
  }

  const students = await fetchResearchStudentsBelowTarget(targetHours, weekStart, weekEnd);
  if (students.length === 0) {
    return {
      ran: false,
      reason: "no_students_below_target",
      weekStart,
      weekEnd,
      targetHours,
      matched: 0,
      locked: 0,
      students: []
    };
  }

  const studentIds = students.map((student) => student.student_id);
  const lockIds = await createStudentAccessLocks({
    studentIds,
    date: weekStart,
    reason: ACCESS_LOCK_REASON_RESEARCH_WEEKLY_LOW_HOURS
  });

  return {
    ran: lockIds.length > 0,
    reason: lockIds.length > 0 ? "locks_created" : "already_locked",
    weekStart,
    weekEnd,
    targetHours,
    matched: students.length,
    locked: lockIds.length,
    lockIds,
    studentIds,
    students
  };
}

async function runSchedulerTick(now = new Date()) {
  if (!isEvaluationWindow(now)) {
    return { ran: false, reason: "outside_evaluation_window" };
  }

  try {
    const result = await runWeeklyResearchAttendanceSuspensionCycle(now);
    if (result.ran) {
      console.log(
        "[WeeklyResearchAttendanceSuspension] Cycle executed:",
        JSON.stringify({
          weekStart: result.weekStart,
          weekEnd: result.weekEnd,
          targetHours: result.targetHours,
          matched: result.matched,
          locked: result.locked
        })
      );
    }
    return result;
  } catch (error) {
    console.error("[WeeklyResearchAttendanceSuspension] Cycle failed:", error.message);
    return {
      ran: false,
      reason: "error",
      error: error.message
    };
  }
}

function startMonitoring() {
  console.log(
    "[WeeklyResearchAttendanceSuspension] Starting weekly research suspension scheduler " +
    `(default target: ${DEFAULT_TARGET_HOURS}h, checks every hour, runs Mon 00:00-02:59 WIB)...`
  );
  runSchedulerTick().catch(() => {});
  setInterval(() => {
    runSchedulerTick().catch(() => {});
  }, ONE_HOUR);
}

module.exports = {
  isEvaluationWindow,
  getPreviousJakartaWeekBounds,
  runWeeklyResearchAttendanceSuspensionCycle,
  runSchedulerTick,
  startMonitoring
};

if (require.main === module) {
  runWeeklyResearchAttendanceSuspensionCycle()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch(() => process.exit(1));
}
