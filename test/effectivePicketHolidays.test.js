const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getEffectivePicketHolidayDateSet,
  isPicketLockCoveredByEffectiveHoliday,
  mergeEffectivePicketHolidays
} = require("../utils/effectivePicketHolidays");
const {
  applyEffectiveHolidayToAssignment,
  buildPicketCheckoutRequirement
} = require("../utils/picketService");
const { findNextPicketReplacementDate } = require("../utils/picketLeaveReplacement");

function settings({ exclude = true, holidays = [] } = {}) {
  return {
    attendanceRules: {
      excludeHolidaysFromWorkdays: exclude,
      holidays
    }
  };
}

function systemHoliday(date = "2026-08-17") {
  return { date, name: "Hari Kemerdekaan", active: true };
}

function picketHoliday(date = "2026-08-20") {
  return {
    id: `PKT-HOL-${date}`,
    holiday_date: date,
    name: "Libur Piket Khusus",
    notes: "Kegiatan internal"
  };
}

function ordinaryAssignment(date = "2026-08-17") {
  return {
    id: "PKT-SCH-1",
    date,
    status: "Ditugaskan",
    submitted: false,
    isHoliday: false,
    is_holiday: false,
    isExempt: false,
    is_exempt: false,
    submissionId: null,
    photoUrl: null
  };
}

test("system holiday exempts an existing picket assignment", () => {
  const [holiday] = mergeEffectivePicketHolidays({
    settings: settings({ holidays: [systemHoliday()] })
  });
  const assignment = applyEffectiveHolidayToAssignment(ordinaryAssignment(), holiday);

  assert.equal(assignment.status, "Libur");
  assert.equal(assignment.isHoliday, true);
  assert.equal(assignment.is_holiday, true);
  assert.equal(assignment.isExempt, true);
  assert.equal(assignment.is_exempt, true);
  assert.equal(assignment.submitted, false);
  assert.equal(assignment.holiday.source, "system");
});

test("checkout on a system holiday does not require a picket photo", () => {
  const [holiday] = mergeEffectivePicketHolidays({
    settings: settings({ holidays: [systemHoliday()] })
  });
  const assignment = applyEffectiveHolidayToAssignment(ordinaryAssignment(), holiday);
  const requirement = buildPicketCheckoutRequirement({ assignment, holiday });

  assert.equal(requirement.required, false);
  assert.equal(requirement.submitted, false);
  assert.equal(requirement.assignment.submissionId, null);
  assert.equal(requirement.assignment.photoUrl, null);
});

test("picket-specific holiday remains effective independently", () => {
  const [holiday] = mergeEffectivePicketHolidays({
    settings: settings(),
    picketHolidays: [picketHoliday()]
  });

  assert.equal(holiday.date, "2026-08-20");
  assert.equal(holiday.source, "picket");
  assert.equal(holiday.editable, true);
});

test("duplicate date across both sources produces one system-priority holiday", () => {
  const holidays = mergeEffectivePicketHolidays({
    settings: settings({ holidays: [systemHoliday()] }),
    picketHolidays: [picketHoliday("2026-08-17")]
  });

  assert.equal(holidays.length, 1);
  assert.equal(holidays[0].source, "system");
  assert.equal(holidays[0].id, "system:2026-08-17");
});

test("removing a system holiday preserves a same-date picket-specific holiday", () => {
  const before = mergeEffectivePicketHolidays({
    settings: settings({ holidays: [systemHoliday()] }),
    picketHolidays: [picketHoliday("2026-08-17")]
  });
  const after = mergeEffectivePicketHolidays({
    settings: settings({ holidays: [] }),
    picketHolidays: [picketHoliday("2026-08-17")]
  });

  assert.equal(before[0].source, "system");
  assert.equal(after.length, 1);
  assert.equal(after[0].source, "picket");
});

test("overdue missing-picket lock is covered by every effective holiday source", () => {
  const holidays = mergeEffectivePicketHolidays({
    settings: settings({ holidays: [systemHoliday()] }),
    picketHolidays: [picketHoliday()]
  });

  assert.equal(isPicketLockCoveredByEffectiveHoliday({
    reason: "PICKET_SUBMISSION_MISSING",
    lock_date: "2026-08-17"
  }, holidays), true);
  assert.equal(getEffectivePicketHolidayDateSet(holidays).has("2026-08-20"), true);
});

test("existing invalid-picket lock is released when its date becomes a system holiday", () => {
  const holidays = mergeEffectivePicketHolidays({
    settings: settings({ holidays: [systemHoliday()] })
  });

  assert.equal(isPicketLockCoveredByEffectiveHoliday({
    reason: "PICKET_SUBMISSION_INVALID",
    lockDate: "2026-08-17"
  }, holidays), true);
  assert.equal(isPicketLockCoveredByEffectiveHoliday({
    reason: "WORK_HOURS_UNDER_8",
    lockDate: "2026-08-17"
  }, holidays), false);
});

test("replacement schedule skips system and picket-specific holidays", () => {
  const holidays = mergeEffectivePicketHolidays({
    settings: settings({ holidays: [systemHoliday("2026-08-18")] }),
    picketHolidays: [picketHoliday("2026-08-19")]
  });

  assert.equal(findNextPicketReplacementDate({
    afterDate: "2026-08-17",
    activeDayIds: [1, 2, 3, 4, 5],
    holidayDates: getEffectivePicketHolidayDateSet(holidays)
  }), "2026-08-20");
});

test("disabled system holiday exclusion leaves picket-specific holidays active", () => {
  const holidays = mergeEffectivePicketHolidays({
    settings: settings({ exclude: false, holidays: [systemHoliday()] }),
    picketHolidays: [picketHoliday()]
  });

  assert.deepEqual(holidays.map((holiday) => holiday.date), ["2026-08-20"]);
  assert.equal(holidays[0].source, "picket");
});

test("effective holiday response includes camelCase and snake_case metadata", () => {
  const holidays = mergeEffectivePicketHolidays({
    settings: settings({ holidays: [systemHoliday()] }),
    picketHolidays: [picketHoliday()]
  });
  const system = holidays.find((holiday) => holiday.source === "system");
  const picket = holidays.find((holiday) => holiday.source === "picket");

  assert.equal(system.holidaySource, system.holiday_source);
  assert.equal(system.isEditable, system.is_editable);
  assert.equal(system.holidayDate, system.holiday_date);
  assert.equal(picket.holidaySource, picket.holiday_source);
  assert.equal(picket.isEditable, picket.is_editable);
  assert.equal(picket.holidayDate, picket.holiday_date);
});
