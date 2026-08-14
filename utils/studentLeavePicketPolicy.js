const SUPPORTED_LEAVE_TYPES = ["cuti", "izin", "sakit", "wfh"];

function normalizeStudentLeaveType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return SUPPORTED_LEAVE_TYPES.includes(normalized) ? normalized : null;
}

function expandIsoDateRange(startDate, endDate) {
  const start = String(startDate || "").trim().slice(0, 10);
  const end = String(endDate || start || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) {
    const error = new Error("Periode izin mahasiswa tidak valid.");
    error.statusCode = 400;
    throw error;
  }

  const dates = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function resolveStudentLeavePicketAction({ leaveType, status }) {
  if (String(status || "").trim() !== "Disetujui") return "clear";
  return normalizeStudentLeaveType(leaveType) === "wfh" ? "complete" : "leave";
}

function selectPicketSchedulesOnLeaveDates(schedules = [], leaveDates = []) {
  const allowedDates = new Set(leaveDates.map((date) => String(date || "").slice(0, 10)));
  return schedules.filter((schedule) => {
    const scheduleDate = String(
      schedule?.date_text || schedule?.schedule_date || schedule?.date || ""
    ).slice(0, 10);
    return allowedDates.has(scheduleDate);
  });
}

module.exports = {
  expandIsoDateRange,
  normalizeStudentLeaveType,
  resolveStudentLeavePicketAction,
  selectPicketSchedulesOnLeaveDates
};
