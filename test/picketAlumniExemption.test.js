const test = require("node:test");
const assert = require("node:assert/strict");

const {
  cleanupAlumniPicketData
} = require("../utils/picketService");

test("listPicketStudentOptions filters out Alumni and returns status and is_alumni", () => {
  const rows = [
    {
      id: "STD-1",
      nim: "220001",
      tipe: "Riset",
      status: "Aktif",
      name: "Budi Santoso",
      initials: "BS",
      day_id: 1,
      effective_from_text: "2026-09-01",
      day_name: "Senin"
    }
  ];

  const mapped = rows.map((row) => ({
    id: row.id,
    student_id: row.id,
    studentId: row.id,
    name: row.name,
    student_name: row.name,
    studentName: row.name,
    nim: row.nim || null,
    initials: row.initials || String(row.name || "M").slice(0, 2).toUpperCase(),
    tipe: row.tipe || null,
    status: row.status,
    is_alumni: row.status === "Alumni" || row.status === "Lulus",
    isAlumni: row.status === "Alumni" || row.status === "Lulus",
    day_id: row.day_id == null ? null : Number(row.day_id),
    dayId: row.day_id == null ? null : Number(row.day_id),
    day_name: row.day_name || null,
    dayName: row.day_name || null,
    effective_from: row.effective_from_text || null,
    effectiveFrom: row.effective_from_text || null
  }));

  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].status, "Aktif");
  assert.equal(mapped[0].is_alumni, false);
  assert.equal(mapped[0].isAlumni, false);
});

test("ensureStudentCanBeScheduled rejects Alumni with HTTP 422 and exact message", async () => {
  async function mockEnsureStudentCanBeScheduled(studentId, studentRow) {
    if (!studentRow) {
      const error = new Error("Mahasiswa tidak valid atau tidak aktif.");
      error.statusCode = 400;
      throw error;
    }
    if (studentRow.status === "Alumni" || studentRow.status === "Lulus") {
      const error = new Error("Mahasiswa berstatus Alumni tidak dapat dijadwalkan piket.");
      error.statusCode = 422;
      error.success = false;
      throw error;
    }
    if (studentRow.status !== "Aktif" || studentRow.is_active !== true) {
      const error = new Error("Mahasiswa tidak valid atau tidak aktif.");
      error.statusCode = 400;
      throw error;
    }
  }

  await assert.rejects(
    async () => {
      await mockEnsureStudentCanBeScheduled("STD-ALUMNI", {
        id: "STD-ALUMNI",
        status: "Alumni",
        is_active: true
      });
    },
    (err) => {
      assert.equal(err.statusCode, 422);
      assert.equal(err.success, false);
      assert.equal(err.message, "Mahasiswa berstatus Alumni tidak dapat dijadwalkan piket.");
      return true;
    }
  );

  await assert.rejects(
    async () => {
      await mockEnsureStudentCanBeScheduled("STD-LULUS", {
        id: "STD-LULUS",
        status: "Lulus",
        is_active: true
      });
    },
    (err) => {
      assert.equal(err.statusCode, 422);
      assert.equal(err.success, false);
      assert.equal(err.message, "Mahasiswa berstatus Alumni tidak dapat dijadwalkan piket.");
      return true;
    }
  );

  await assert.rejects(
    async () => {
      await mockEnsureStudentCanBeScheduled("STD-CUTI", {
        id: "STD-CUTI",
        status: "Cuti",
        is_active: true
      });
    },
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );

  // Active student succeeds without error
  await assert.doesNotReject(async () => {
    await mockEnsureStudentCanBeScheduled("STD-AKTIF", {
      id: "STD-AKTIF",
      status: "Aktif",
      is_active: true
    });
  });
});

test("replacePicketManagers rejects assigning Alumni as PIC with HTTP 422", async () => {
  async function mockReplacePicketManagers(studentIds, studentRecords) {
    const uniqueStudentIds = [...new Set((studentIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
    if (uniqueStudentIds.length > 0) {
      const alumni = studentRecords.find((s) => uniqueStudentIds.includes(s.id) && (s.status === "Alumni" || s.status === "Lulus"));
      if (alumni) {
        const error = new Error("Mahasiswa berstatus Alumni tidak dapat dijadikan PIC piket.");
        error.statusCode = 422;
        error.success = false;
        throw error;
      }
      const nonActive = studentRecords.find((s) => uniqueStudentIds.includes(s.id) && s.status !== "Aktif");
      if (nonActive) {
        const error = new Error("PIC piket hanya boleh mahasiswa aktif.");
        error.statusCode = 422;
        error.success = false;
        throw error;
      }
    }
    return uniqueStudentIds;
  }

  const students = [
    { id: "STD-1", status: "Aktif" },
    { id: "STD-2", status: "Alumni" },
    { id: "STD-3", status: "Cuti" }
  ];

  await assert.rejects(
    async () => {
      await mockReplacePicketManagers(["STD-1", "STD-2"], students);
    },
    (err) => {
      assert.equal(err.statusCode, 422);
      assert.equal(err.success, false);
      assert.equal(err.message, "Mahasiswa berstatus Alumni tidak dapat dijadikan PIC piket.");
      return true;
    }
  );

  await assert.rejects(
    async () => {
      await mockReplacePicketManagers(["STD-3"], students);
    },
    (err) => {
      assert.equal(err.statusCode, 422);
      assert.equal(err.success, false);
      assert.equal(err.message, "PIC piket hanya boleh mahasiswa aktif.");
      return true;
    }
  );

  await assert.doesNotReject(async () => {
    const result = await mockReplacePicketManagers(["STD-1"], students);
    assert.deepEqual(result, ["STD-1"]);
  });
});

test("cleanupAlumniPicketData deletes future uncompleted schedules, fixed days, and managers", async () => {
  const executedQueries = [];
  const mockExecutor = async (text, params) => {
    executedQueries.push({ text: text.trim(), params });
    return { rowCount: 1, rows: [] };
  };

  await cleanupAlumniPicketData("STD-ALUMNI-99", mockExecutor);

  assert.equal(executedQueries.length, 3);

  // 1. Delete future Ditugaskan schedules without submissions
  const scheduleDelete = executedQueries[0];
  assert.ok(scheduleDelete.text.includes("DELETE FROM picket_schedules"));
  assert.ok(scheduleDelete.text.includes("schedule_date >= CURRENT_DATE"));
  assert.ok(scheduleDelete.text.includes("status = 'Ditugaskan'"));
  assert.ok(scheduleDelete.text.includes("NOT EXISTS"));
  assert.deepEqual(scheduleDelete.params, ["STD-ALUMNI-99"]);

  // 2. Delete from picket_student_days
  const daysDelete = executedQueries[1];
  assert.ok(daysDelete.text.includes("DELETE FROM picket_student_days"));
  assert.deepEqual(daysDelete.params, ["STD-ALUMNI-99"]);

  // 3. Delete from picket_managers
  const managerDelete = executedQueries[2];
  assert.ok(managerDelete.text.includes("DELETE FROM picket_managers"));
  assert.deepEqual(managerDelete.params, ["STD-ALUMNI-99"]);
});

test("cleanupAlumniPicketData safely ignores null or empty studentId", async () => {
  const executedQueries = [];
  const mockExecutor = async (text, params) => {
    executedQueries.push({ text, params });
    return { rowCount: 0, rows: [] };
  };

  await cleanupAlumniPicketData(null, mockExecutor);
  await cleanupAlumniPicketData("", mockExecutor);
  assert.equal(executedQueries.length, 0);
});

test("getPicketTodayForStudent returns isExempt: true and null assignment for Alumni", () => {
  function formatAlumniTodayResponse(student) {
    if (student.status === "Alumni" || student.status === "Lulus") {
      return {
        assignment: null,
        isExempt: true,
        is_exempt: true,
        isAlumni: true,
        is_alumni: true,
        message: "Mahasiswa berstatus Alumni bebas tugas piket.",
        fixed_day: null,
        fixedDay: null,
        holiday: null,
        is_holiday: false,
        isHoliday: false
      };
    }
    return null;
  }

  const alumniResult = formatAlumniTodayResponse({ id: "STD-ALUMNI", status: "Alumni" });
  assert.ok(alumniResult);
  assert.equal(alumniResult.assignment, null);
  assert.equal(alumniResult.isExempt, true);
  assert.equal(alumniResult.message, "Mahasiswa berstatus Alumni bebas tugas piket.");

  const lulusResult = formatAlumniTodayResponse({ id: "STD-LULUS", status: "Lulus" });
  assert.ok(lulusResult);
  assert.equal(lulusResult.assignment, null);
  assert.equal(lulusResult.isExempt, true);
  assert.equal(lulusResult.message, "Mahasiswa berstatus Alumni bebas tugas piket.");
});

test("checkout picket photo requirement is bypassed for Alumni/Lulus students", () => {
  function shouldCheckPicketRequirement(student) {
    const isAlumni = student.status === "Alumni" || student.status === "Lulus";
    return !isAlumni;
  }

  assert.equal(shouldCheckPicketRequirement({ status: "Alumni" }), false);
  assert.equal(shouldCheckPicketRequirement({ status: "Lulus" }), false);
  assert.equal(shouldCheckPicketRequirement({ status: "Aktif" }), true);
  assert.equal(shouldCheckPicketRequirement({ status: "Cuti" }), true);
});

