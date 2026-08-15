const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPicketCheckoutRequirement,
  mapPicketAssignment
} = require("../utils/picketService");

function assignmentRow(overrides = {}) {
  return {
    id: "PKT-SCH-1",
    date_text: "2026-08-14",
    student_id: "STU-1",
    status: "Ditugaskan",
    auto_leave_request_id: null,
    auto_leave_type: null,
    active_leave_request_id: null,
    active_leave_type: null,
    active_leave_status: null,
    picket_leave_status: null,
    submission_id: null,
    submission_status: null,
    submission_photo_url: null,
    ...overrides
  };
}

test("approved WFH on the scheduled picket date completes checkout requirement without a photo", () => {
  const assignment = mapPicketAssignment(assignmentRow({
    auto_leave_request_id: "LR-WFH-1",
    auto_leave_type: "wfh",
    active_leave_request_id: "LR-WFH-1",
    active_leave_type: "WFH",
    active_leave_status: "disetujui"
  }));
  const requirement = buildPicketCheckoutRequirement({
    assignment,
    approvedStudentLeave: { id: "LR-WFH-1", type: "wfh", status: "Disetujui" }
  });

  assert.equal(requirement.required, false);
  assert.equal(requirement.submitted, true);
  assert.equal(requirement.assignment.status, "Selesai");
  assert.equal(requirement.assignment.submissionId, null);
  assert.equal(requirement.assignment.photoUrl, null);
  assert.equal(requirement.assignment.autoCompletedByWfh, true);
  assert.equal(requirement.assignment.auto_completed_by_wfh, true);
  assert.equal(requirement.assignment.autoLeaveType, "wfh");
  assert.equal(requirement.assignment.auto_leave_type, "wfh");
});

test("approved WFH outside the student's picket day has no assignment and never requires a photo", () => {
  const requirement = buildPicketCheckoutRequirement({
    assignment: null,
    approvedStudentLeave: { id: "LR-WFH-2", type: "wfh", status: "Disetujui" }
  });

  assert.equal(requirement.required, false);
  assert.equal(requirement.assignment, null);
});

test("ordinary picket requires a photo submission, then permits checkout after submission", () => {
  const withoutPhoto = mapPicketAssignment(assignmentRow());
  const blocked = buildPicketCheckoutRequirement({ assignment: withoutPhoto });

  assert.equal(blocked.required, true);
  assert.equal(blocked.submitted, false);

  const withPhoto = mapPicketAssignment(assignmentRow({
    submission_id: "PKT-SUB-1",
    submission_status: "Terkirim",
    submission_photo_url: "/uploads/picket/photo.jpg"
  }));
  const permitted = buildPicketCheckoutRequirement({ assignment: withPhoto });

  assert.equal(permitted.required, false);
  assert.equal(permitted.submitted, true);
  assert.equal(permitted.assignment.photoUrl, "/uploads/picket/photo.jpg");
});

test("approved non-WFH leave permits checkout without a photo", () => {
  const assignment = mapPicketAssignment(assignmentRow({
    active_leave_request_id: "LR-IZIN-1",
    active_leave_type: "Izin",
    active_leave_status: "DISETUJUI"
  }));
  const requirement = buildPicketCheckoutRequirement({
    assignment,
    approvedStudentLeave: { id: "LR-IZIN-1", type: "izin", status: "Disetujui" }
  });

  assert.equal(requirement.required, false);
  assert.equal(requirement.approvedLeave, true);
  assert.equal(requirement.assignment.status, "Izin");
  assert.equal(requirement.assignment.autoCompletedByWfh, false);
  assert.equal(requirement.assignment.photoUrl, null);
});

test("cancelled, rejected, pending, or deleted WFH no longer suppresses the normal photo requirement", () => {
  for (const inactiveStatus of ["Ditolak", "Menunggu", null]) {
    const assignment = mapPicketAssignment(assignmentRow({
      auto_leave_request_id: "LR-WFH-STALE",
      auto_leave_type: "wfh",
      active_leave_request_id: inactiveStatus ? "LR-WFH-STALE" : null,
      active_leave_type: inactiveStatus ? "wfh" : null,
      active_leave_status: inactiveStatus
    }));
    const requirement = buildPicketCheckoutRequirement({ assignment });

    assert.equal(assignment.autoCompletedByWfh, false, `status ${inactiveStatus || "deleted"}`);
    assert.equal(assignment.auto_completed_by_wfh, false, `status ${inactiveStatus || "deleted"}`);
    assert.equal(assignment.status, "Ditugaskan", `status ${inactiveStatus || "deleted"}`);
    assert.equal(requirement.required, true, `status ${inactiveStatus || "deleted"}`);
  }
});

test("assignment responses keep WFH and leave metadata in camelCase and snake_case", () => {
  const assignment = mapPicketAssignment(assignmentRow({
    active_leave_request_id: "LR-WFH-3",
    active_leave_type: "wfh",
    active_leave_status: "Disetujui"
  }));

  assert.equal(assignment.autoCompletedByWfh, assignment.auto_completed_by_wfh);
  assert.equal(assignment.autoLeaveType, assignment.auto_leave_type);
  assert.equal(assignment.autoLeaveRequestId, assignment.auto_leave_request_id);
  assert.equal(assignment.leaveStatus, assignment.leave_status);
  assert.equal(assignment.leaveRequestId, assignment.leave_request_id);
  assert.equal(assignment.leaveType, assignment.leave_type);
});
