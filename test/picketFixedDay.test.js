const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRandomizedPicketDayAssignments,
  chooseLeastLoadedPicketDay,
  chooseRandomPicketTask
} = require("../utils/picketService");

test("new student is assigned to one of the least populated fixed days", () => {
  const counts = new Map([[1, 3], [2, 1], [3, 1], [4, 2], [5, 4]]);

  assert.equal(chooseLeastLoadedPicketDay([1, 2, 3, 4, 5], counts, () => 0), 2);
  assert.equal(chooseLeastLoadedPicketDay([1, 2, 3, 4, 5], counts, () => 0.99), 3);
});

test("random picker assigns every student exactly once and balances weekdays", () => {
  const students = Array.from({ length: 12 }, (_, index) => `student-${index + 1}`);
  const assignments = buildRandomizedPicketDayAssignments(students, [1, 2, 3, 4, 5], () => 0.42);

  assert.equal(assignments.length, students.length);
  assert.equal(new Set(assignments.map((item) => item.studentId)).size, students.length);

  const counts = assignments.reduce((result, item) => {
    result.set(item.dayId, Number(result.get(item.dayId) || 0) + 1);
    return result;
  }, new Map());
  const totals = [...counts.values()];
  assert.ok(Math.max(...totals) - Math.min(...totals) <= 1);
});

test("fixed weekday assignment is stable data, independent from dated schedules", () => {
  const assignments = buildRandomizedPicketDayAssignments(["student-a"], [4], () => 0.5);

  assert.deepEqual(assignments, [{ studentId: "student-a", dayId: 4 }]);
});

test("task picker randomizes the task for each materialized weekly occurrence", () => {
  const tasks = [{ id: "task-a" }, { id: "task-b" }, { id: "task-c" }];

  assert.equal(chooseRandomPicketTask(tasks, () => 0).id, "task-a");
  assert.equal(chooseRandomPicketTask(tasks, () => 0.99).id, "task-c");
});
