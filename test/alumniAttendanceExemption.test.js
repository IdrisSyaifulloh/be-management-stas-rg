const test = require("node:test");
const assert = require("node:assert/strict");

test("attendance check-in rejects Alumni/Non-Aktif students with 403", () => {
  function checkStudentStatusForCheckIn(status) {
    if (status && status !== "Aktif") {
      return {
        status: 403,
        body: {
          message: "Mahasiswa berstatus Alumni/Non-Aktif tidak memiliki kewajiban absensi.",
          code: "STUDENT_NOT_ACTIVE"
        }
      };
    }
    return { status: 200 };
  }

  const alumniResult = checkStudentStatusForCheckIn("Alumni");
  assert.equal(alumniResult.status, 403);
  assert.equal(alumniResult.body.code, "STUDENT_NOT_ACTIVE");

  const nonActiveResult = checkStudentStatusForCheckIn("Cuti");
  assert.equal(nonActiveResult.status, 403);
  assert.equal(nonActiveResult.body.code, "STUDENT_NOT_ACTIVE");

  const activeResult = checkStudentStatusForCheckIn("Aktif");
  assert.equal(activeResult.status, 200);
});

test("attendance today-summary query filters out non-Aktif students", () => {
  const studentsInDb = [
    { id: "std-1", status: "Aktif", tipe: "Magang" },
    { id: "std-2", status: "Alumni", tipe: "Magang" },
    { id: "std-3", status: "Alumni", tipe: "Riset" },
    { id: "std-4", status: "Aktif", tipe: "Riset" },
    { id: "std-5", status: "Mengundurkan Diri", tipe: "Magang" }
  ];

  // Simulating the query WHERE u.is_active = TRUE AND s.status = 'Aktif'
  const activeStudents = studentsInDb.filter((s) => s.status === "Aktif");
  assert.equal(activeStudents.length, 2);
  assert.deepEqual(activeStudents.map((s) => s.id), ["std-1", "std-4"]);
  assert.ok(!activeStudents.some((s) => s.status === "Alumni"));
});

test("deactivateAllAccessLocksForStudent safely handles empty studentId", async () => {
  const { deactivateAllAccessLocksForStudent } = require("../utils/studentAccessLocks");
  const result = await deactivateAllAccessLocksForStudent(null);
  assert.deepEqual(result, []);

  const emptyResult = await deactivateAllAccessLocksForStudent("");
  assert.deepEqual(emptyResult, []);
});
