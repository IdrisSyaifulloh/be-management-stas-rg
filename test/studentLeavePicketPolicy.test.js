const test = require("node:test");
const assert = require("node:assert/strict");

const {
  expandIsoDateRange,
  resolveStudentLeavePicketAction,
  selectPicketSchedulesOnLeaveDates
} = require("../utils/studentLeavePicketPolicy");

test("approved non-WFH student leave grants picket leave", () => {
  for (const leaveType of ["cuti", "izin", "sakit"]) {
    assert.equal(
      resolveStudentLeavePicketAction({ leaveType, status: "Disetujui" }),
      "leave"
    );
  }
});

test("approved WFH completes picket automatically", () => {
  assert.equal(
    resolveStudentLeavePicketAction({ leaveType: "wfh", status: "Disetujui" }),
    "complete"
  );
});

test("WFH only selects a picket schedule on the same date", () => {
  const schedules = [
    { id: "PKT-MON", date_text: "2026-08-10" },
    { id: "PKT-THU", date_text: "2026-08-13" }
  ];

  assert.deepEqual(
    selectPicketSchedulesOnLeaveDates(schedules, ["2026-08-13"]),
    [{ id: "PKT-THU", date_text: "2026-08-13" }]
  );
});

test("WFH outside the student's picket day does not select or complete a schedule", () => {
  const schedules = [{ id: "PKT-THU", date_text: "2026-08-13" }];

  assert.deepEqual(
    selectPicketSchedulesOnLeaveDates(schedules, ["2026-08-12"]),
    []
  );
});

test("non-approved student leave clears its automatic picket effect", () => {
  for (const status of ["Menunggu", "Ditolak"]) {
    assert.equal(resolveStudentLeavePicketAction({ leaveType: "izin", status }), "clear");
    assert.equal(resolveStudentLeavePicketAction({ leaveType: "wfh", status }), "clear");
  }
});

test("student leave date range includes every covered date", () => {
  assert.deepEqual(expandIsoDateRange("2026-08-12", "2026-08-14"), [
    "2026-08-12",
    "2026-08-13",
    "2026-08-14"
  ]);
});
