const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRisetWeeklyMonitorFields
} = require("../utils/risetWeeklyMonitor");

function researchStudent(overrides = {}) {
  return {
    id: "RIS-1",
    tipe: "Riset",
    status: "Aktif",
    ...overrides
  };
}

function monitorFields({
  hours = 4,
  attendance = null,
  leaveStudentIds = [],
  isHoliday = false,
  configuredMinHours = 4,
  dailyAttendanceWindowPassed = true
} = {}) {
  return buildRisetWeeklyMonitorFields({
    students: [researchStudent()],
    weeklyHoursRows: [{ student_id: "RIS-1", total_hours: hours }],
    attendanceByStudentId: attendance ? new Map([["RIS-1", attendance]]) : new Map(),
    leaveStudentIds,
    isHoliday,
    configuredMinHours,
    dailyAttendanceWindowPassed
  });
}

test("absent research student meeting the weekly minimum is classified as fulfilled", () => {
  const result = monitorFields({ hours: 4.25 });

  assert.deepEqual(result.risetWeeklyMeetsMinIds, ["RIS-1"]);
  assert.equal(result.risetWeeklyHoursByStudentId["RIS-1"], 4.25);
});

test("absent research student below the weekly minimum is not classified as fulfilled", () => {
  const result = monitorFields({ hours: 3.99 });

  assert.deepEqual(result.risetWeeklyMeetsMinIds, []);
});

test("present research student meeting the weekly minimum is not classified as fulfilled absence", () => {
  for (const status of ["Hadir", "WFH"]) {
    const result = monitorFields({ hours: 5, attendance: { status } });
    assert.deepEqual(result.risetWeeklyMeetsMinIds, []);
  }
});

test("research student on leave or a holiday is not classified as fulfilled absence", () => {
  const onLeave = monitorFields({ hours: 5, leaveStudentIds: ["RIS-1"] });
  const onHoliday = monitorFields({ hours: 5, isHoliday: true });
  const beforeCutoff = monitorFields({ hours: 5, dailyAttendanceWindowPassed: false });

  assert.deepEqual(onLeave.risetWeeklyMeetsMinIds, []);
  assert.deepEqual(onHoliday.risetWeeklyMeetsMinIds, []);
  assert.deepEqual(beforeCutoff.risetWeeklyMeetsMinIds, []);
});

test("configured research weekly minimum can differ from the four-hour default", () => {
  const belowConfigured = monitorFields({ hours: 5, configuredMinHours: 5.5 });
  const meetsConfigured = monitorFields({ hours: 5.5, configuredMinHours: 5.5 });
  const invalidFallback = monitorFields({ hours: 4, configuredMinHours: "invalid" });

  assert.equal(belowConfigured.risetWeeklyMinHours, 5.5);
  assert.deepEqual(belowConfigured.risetWeeklyMeetsMinIds, []);
  assert.deepEqual(meetsConfigured.risetWeeklyMeetsMinIds, ["RIS-1"]);
  assert.equal(invalidFallback.risetWeeklyMinHours, 4);
});

test("research weekly monitor response has identical camelCase and snake_case values", () => {
  const result = monitorFields({ hours: 4.75 });

  assert.equal(result.risetWeeklyMinHours, result.riset_weekly_min_hours);
  assert.deepEqual(
    result.risetWeeklyHoursByStudentId,
    result.riset_weekly_hours_by_student_id
  );
  assert.deepEqual(result.risetWeeklyMeetsMinIds, result.riset_weekly_meets_min_ids);
});
