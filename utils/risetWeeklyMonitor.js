const DEFAULT_RISET_WEEKLY_MIN_HOURS = 4;

function normalizeRisetWeeklyMinHours(value, fallback = DEFAULT_RISET_WEEKLY_MIN_HOURS) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function roundWeeklyHours(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed * 100) / 100;
}

function getAttendanceForStudent(attendanceByStudentId, studentId) {
  if (attendanceByStudentId instanceof Map) return attendanceByStudentId.get(studentId) || null;
  return attendanceByStudentId?.[studentId] || null;
}

function buildRisetWeeklyMonitorFields({
  students = [],
  weeklyHoursRows = [],
  attendanceByStudentId = {},
  leaveStudentIds = [],
  configuredMinHours = DEFAULT_RISET_WEEKLY_MIN_HOURS,
  isHoliday = false,
  dailyAttendanceWindowPassed = false
} = {}) {
  const risetWeeklyMinHours = normalizeRisetWeeklyMinHours(configuredMinHours);
  const risetWeeklyHoursByStudentId = {};

  for (const student of students) {
    if (String(student?.tipe || "").toLowerCase() === "riset") {
      risetWeeklyHoursByStudentId[student.id] = 0;
    }
  }

  for (const row of weeklyHoursRows) {
    const studentId = row.student_id || row.studentId;
    if (!studentId) continue;
    risetWeeklyHoursByStudentId[studentId] = roundWeeklyHours(
      row.total_hours ?? row.totalHours ?? row.hours
    );
  }

  const leaveSet = leaveStudentIds instanceof Set
    ? leaveStudentIds
    : new Set(leaveStudentIds || []);
  const risetWeeklyMeetsMinIds = [];

  if (dailyAttendanceWindowPassed && !isHoliday) {
    for (const student of students) {
      if (
        String(student?.tipe || "").toLowerCase() !== "riset" ||
        String(student?.status || "").toLowerCase() !== "aktif"
      ) {
        continue;
      }

      const attendance = getAttendanceForStudent(attendanceByStudentId, student.id);
      const todayStatus = String(attendance?.status || "").trim().toLowerCase();
      const isPresentToday = todayStatus === "hadir" || todayStatus === "wfh";
      const isOnLeaveToday =
        leaveSet.has(student.id) ||
        todayStatus === "cuti" ||
        todayStatus === "izin" ||
        todayStatus === "sakit";
      const weeklyHours = risetWeeklyHoursByStudentId[student.id] || 0;

      if (!isPresentToday && !isOnLeaveToday && weeklyHours >= risetWeeklyMinHours) {
        risetWeeklyMeetsMinIds.push(student.id);
      }
    }
  }

  return {
    risetWeeklyMinHours,
    riset_weekly_min_hours: risetWeeklyMinHours,
    risetWeeklyHoursByStudentId,
    riset_weekly_hours_by_student_id: risetWeeklyHoursByStudentId,
    risetWeeklyMeetsMinIds,
    riset_weekly_meets_min_ids: risetWeeklyMeetsMinIds
  };
}

module.exports = {
  DEFAULT_RISET_WEEKLY_MIN_HOURS,
  buildRisetWeeklyMonitorFields,
  normalizeRisetWeeklyMinHours,
  roundWeeklyHours
};
