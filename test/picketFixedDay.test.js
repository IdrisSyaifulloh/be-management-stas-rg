const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRandomizedPicketDayAssignments,
  chooseLeastLoadedPicketDay,
  shufflePicketTasks
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

test("task shuffle returns one randomized list without replacement", () => {
  const tasks = [{ id: "task-a" }, { id: "task-b" }, { id: "task-c" }];
  const shuffled = shufflePicketTasks(tasks, () => 0);

  assert.deepEqual(shuffled.map((task) => task.id), ["task-b", "task-c", "task-a"]);
  assert.equal(new Set(shuffled.map((task) => task.id)).size, tasks.length);
  assert.deepEqual(tasks.map((task) => task.id), ["task-a", "task-b", "task-c"]);
});
