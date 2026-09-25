const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../db/pool");
const {
  shufflePicketTasks,
  reconcilePicketAssignmentsForDate
} = require("../utils/picketService");

test.after(async () => {
  await pool.end().catch(() => {});
});

test("Picket task assignment algorithm: allocates all unique task types first, then shares tasks randomly", () => {
  const activeTasks = [
    { id: "TASK-1", name: "Sapu & Pel Laboratorium" },
    { id: "TASK-2", name: "Lap Meja & Monitor" }
  ];
  const studentsNeedingTasks = ["STD-A", "STD-B", "STD-C", "STD-D", "STD-E"];
  const requiredTaskCount = studentsNeedingTasks.length;

  const assignedTaskIdsOnDate = new Set();
  const unassignedTasks = activeTasks.filter((pt) => !assignedTaskIdsOnDate.has(pt.id));
  const shuffledUnassigned = shufflePicketTasks(unassignedTasks);

  const assignedTasks = [];
  // Priority 1: Ensure all distinct active task types are assigned first
  for (const task of shuffledUnassigned) {
    if (assignedTasks.length >= requiredTaskCount) break;
    assignedTasks.push(task);
  }

  // Priority 2: If all task types are occupied and more students need tasks,
  // distribute tasks randomly from active pool (sharing tasks)
  while (assignedTasks.length < requiredTaskCount) {
    const randomPool = shufflePicketTasks(activeTasks);
    for (const task of randomPool) {
      if (assignedTasks.length >= requiredTaskCount) break;
      assignedTasks.push(task);
    }
  }

  // Every student gets a task
  assert.equal(assignedTasks.length, studentsNeedingTasks.length);
  const assignedIds = assignedTasks.map((t) => t.id);

  // Priority 1 satisfied: all distinct active tasks are assigned at least once
  assert.ok(assignedIds.includes("TASK-1"), "TASK-1 must be assigned");
  assert.ok(assignedIds.includes("TASK-2"), "TASK-2 must be assigned");

  // Priority 2 satisfied: multiple students share tasks
  const counts = assignedIds.reduce((acc, id) => {
    acc[id] = (acc[id] || 0) + 1;
    return acc;
  }, {});
  assert.ok(counts["TASK-1"] >= 1);
  assert.ok(counts["TASK-2"] >= 1);
  assert.equal(counts["TASK-1"] + counts["TASK-2"], 5);
});

test("Picket task assignment algorithm: assigns distinct tasks when students <= active tasks", () => {
  const activeTasks = [
    { id: "TASK-1", name: "Sapu & Pel" },
    { id: "TASK-2", name: "Lap Meja" },
    { id: "TASK-3", name: "Buang Sampah" },
    { id: "TASK-4", name: "Cek AC & Lampu" }
  ];
  const studentsNeedingTasks = ["STD-A", "STD-B"];
  const requiredTaskCount = studentsNeedingTasks.length;

  const assignedTaskIdsOnDate = new Set();
  const unassignedTasks = activeTasks.filter((pt) => !assignedTaskIdsOnDate.has(pt.id));
  const shuffledUnassigned = shufflePicketTasks(unassignedTasks);

  const assignedTasks = [];
  for (const task of shuffledUnassigned) {
    if (assignedTasks.length >= requiredTaskCount) break;
    assignedTasks.push(task);
  }
  while (assignedTasks.length < requiredTaskCount) {
    const randomPool = shufflePicketTasks(activeTasks);
    for (const task of randomPool) {
      if (assignedTasks.length >= requiredTaskCount) break;
      assignedTasks.push(task);
    }
  }

  assert.equal(assignedTasks.length, 2);
  const assignedIds = assignedTasks.map((t) => t.id);
  // Both tasks must be unique with zero sharing needed
  assert.equal(new Set(assignedIds).size, 2);
});

test("Picket task assignment algorithm: respects already assigned tasks from earlier schedules", () => {
  const activeTasks = [
    { id: "TASK-1", name: "Sapu & Pel" },
    { id: "TASK-2", name: "Lap Meja" },
    { id: "TASK-3", name: "Buang Sampah" }
  ];
  // Suppose TASK-1 is already assigned on this date
  const assignedTaskIdsOnDate = new Set(["TASK-1"]);
  const studentsNeedingTasks = ["STD-B", "STD-C", "STD-D"];
  const requiredTaskCount = studentsNeedingTasks.length;

  const unassignedTasks = activeTasks.filter((pt) => !assignedTaskIdsOnDate.has(pt.id));
  assert.equal(unassignedTasks.length, 2); // TASK-2, TASK-3

  const shuffledUnassigned = shufflePicketTasks(unassignedTasks);
  const assignedTasks = [];
  for (const task of shuffledUnassigned) {
    if (assignedTasks.length >= requiredTaskCount) break;
    assignedTasks.push(task);
  }
  while (assignedTasks.length < requiredTaskCount) {
    const randomPool = shufflePicketTasks(activeTasks);
    for (const task of randomPool) {
      if (assignedTasks.length >= requiredTaskCount) break;
      assignedTasks.push(task);
    }
  }

  assert.equal(assignedTasks.length, 3);
  const assignedIds = assignedTasks.map((t) => t.id);
  // The unassigned tasks TASK-2 and TASK-3 must both be utilized first
  assert.ok(assignedIds.includes("TASK-2"), "TASK-2 must be prioritized");
  assert.ok(assignedIds.includes("TASK-3"), "TASK-3 must be prioritized");
});

test("reconcilePicketAssignmentsForDate assigns shared tasks when students exceed active tasks", async () => {
  const insertedSchedules = [];

  const mockClient = {
    async query(sql, params) {
      const text = typeof sql === "string" ? sql : sql.text;

      if (text.includes("pg_advisory_xact_lock")) {
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("FROM picket_holidays")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("FROM picket_student_days psd")) {
        return {
          rowCount: 4,
          rows: [
            { student_id: "STD-1" },
            { student_id: "STD-2" },
            { student_id: "STD-3" },
            { student_id: "STD-4" }
          ]
        };
      }
      if (text.includes("DELETE FROM picket_schedules") && text.includes("Alumni")) {
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("FROM picket_schedules psch") && text.includes("FOR UPDATE")) {
        // No existing schedules yet
        return { rowCount: 0, rows: [] };
      }
      if (text.includes("FROM picket_tasks pt")) {
        // Only 2 active tasks for 4 students
        return {
          rowCount: 2,
          rows: [
            { id: "TASK-1", name: "Sapu & Pel", active: true, deleted_at: null },
            { id: "TASK-2", name: "Lap Meja", active: true, deleted_at: null }
          ]
        };
      }
      if (text.includes("INSERT INTO picket_schedules")) {
        insertedSchedules.push({
          id: params[0],
          date: params[1],
          studentId: params[3],
          taskId: params[4]
        });
        return { rowCount: 1, rows: [{ id: params[0] }] };
      }
      if (text.includes("FROM picket_schedules ps") && text.includes("JOIN students s")) {
        return {
          rowCount: insertedSchedules.length,
          rows: insertedSchedules.map((item) => ({
            id: item.id,
            schedule_date: item.date,
            day_id: 1,
            student_id: item.studentId,
            task_id: item.taskId,
            status: "Ditugaskan",
            notes: null,
            auto_leave_request_id: null,
            auto_leave_type: null,
            generated_by: "system",
            generated_at: new Date(),
            created_by: "system",
            updated_by: "system",
            created_at: new Date(),
            updated_at: new Date(),
            nim: "12345",
            student_name: `Student ${item.studentId}`,
            task_name: item.taskId,
            task_description: "Description",
            holiday_id: null,
            submission_id: null
          }))
        };
      }
      return { rowCount: 0, rows: [] };
    }
  };

  const result = await reconcilePicketAssignmentsForDate({
    date: "2026-10-05", // Monday
    generatedBy: "system",
    executor: mockClient
  });

  // Verify all 4 students received a schedule
  assert.equal(insertedSchedules.length, 4);
  const taskIdsUsed = insertedSchedules.map((s) => s.taskId);

  // Both TASK-1 and TASK-2 were assigned (Priority 1)
  assert.ok(taskIdsUsed.includes("TASK-1"), "TASK-1 must be assigned");
  assert.ok(taskIdsUsed.includes("TASK-2"), "TASK-2 must be assigned");

  // Since 4 students and 2 tasks, exactly 2 task types are shared among 4 students
  assert.equal(new Set(taskIdsUsed).size, 2);

  // Result object returned correctly
  assert.equal(result.date, "2026-10-05");
  assert.equal(result.created.length, 4);
});

test("reconcilePicketAssignmentsForDate throws 422 if zero active tasks exist", async () => {
  const mockClient = {
    async query(sql, params) {
      const text = typeof sql === "string" ? sql : sql.text;
      if (text.includes("pg_advisory_xact_lock")) return { rowCount: 1, rows: [] };
      if (text.includes("FROM picket_holidays")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM picket_student_days psd")) {
        return { rowCount: 1, rows: [{ student_id: "STD-1" }] };
      }
      if (text.includes("DELETE FROM picket_schedules")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM picket_schedules psch")) return { rowCount: 0, rows: [] };
      if (text.includes("FROM picket_tasks pt")) {
        return { rowCount: 0, rows: [] }; // Zero active tasks
      }
      return { rowCount: 0, rows: [] };
    }
  };

  await assert.rejects(
    async () => {
      await reconcilePicketAssignmentsForDate({
        date: "2026-10-05",
        executor: mockClient
      });
    },
    (err) => {
      assert.equal(err.statusCode, 422);
      assert.equal(err.code, "PICKET_TASK_CAPACITY_INSUFFICIENT");
      assert.equal(err.message, "Jumlah tugas piket aktif tidak cukup untuk memberikan tugas unik.");
      return true;
    }
  );
});

test("Attendance endpoint gracefully handles picket service error without crashing check-in screen", () => {
  let picketToday = { assignment: null, fixedDay: null, fixed_day: null, holiday: null, isHoliday: false, is_holiday: false };
  let caughtError = null;

  try {
    throw new Error("Jumlah tugas piket aktif tidak cukup untuk memberikan tugas unik.");
  } catch (err) {
    caughtError = err;
  }

  assert.ok(caughtError !== null);
  const responseData = {
    picketToday,
    picketAssignment: picketToday?.assignment || null
  };

  assert.equal(responseData.picketAssignment, null);
  assert.equal(responseData.picketToday.isHoliday, false);
});
