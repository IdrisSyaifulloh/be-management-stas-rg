const test = require("node:test");
const assert = require("node:assert/strict");

const integrationEnabled =
  process.env.RUN_PICKET_INTEGRATION_TESTS === "true" &&
  Boolean(process.env.PICKET_TEST_DATABASE_URL);

if (!integrationEnabled) {
  test("picket schedule database integration tests", { skip: "Set RUN_PICKET_INTEGRATION_TESTS=true and PICKET_TEST_DATABASE_URL." }, () => {});
} else {
  process.env.DATABASE_URL = process.env.PICKET_TEST_DATABASE_URL;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "picket-integration-test-secret";

  const http = require("node:http");
  const express = require("express");
  const picketRouter = require("../routes/api/picket");
  const { pool } = require("../db/pool");
  const { ensurePicketTables } = require("../utils/picketService");

  const prefix = `PICKET-IT-${process.pid}-${Date.now()}`;
  const dates = ["2099-01-04", "2099-01-11", "2099-01-18", "2099-01-25"];
  const replacementRange = ["2099-02-01", "2099-03-31"];
  const userIds = Array.from({ length: 4 }, (_, index) => `${prefix}-USR-${index + 1}`);
  const studentIds = Array.from({ length: 4 }, (_, index) => `${prefix}-STD-${index + 1}`);
  const taskIds = Array.from({ length: 4 }, (_, index) => `${prefix}-TASK-${index + 1}`);
  let server;
  let baseUrl;
  let originalTaskStates = [];

  async function api(method, path, body) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body == null ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  }

  async function createPendingLeave({ suffix, originalDate, studentId, taskId }) {
    const scheduleId = `${prefix}-LEAVE-SCH-${suffix}`;
    const leaveId = `${prefix}-LEAVE-${suffix}`;
    const dayId = new Date(`${originalDate}T00:00:00Z`).getUTCDay();
    await pool.query(
      `
      INSERT INTO picket_schedules
        (id, schedule_date, day_id, student_id, task_id, status, created_by, updated_by)
      VALUES ($1, $2::date, $3, $4, $5, 'Ditugaskan', $6, $6)
      `,
      [scheduleId, originalDate, dayId, studentId, taskId, userIds[0]]
    );
    await pool.query(
      `
      INSERT INTO picket_leave_requests
        (id, schedule_id, assignment_id, student_id, date, reason, status)
      VALUES ($1, $2, $2, $3, $4::date, 'Integration test leave', 'Menunggu')
      `,
      [leaveId, scheduleId, studentId, originalDate]
    );
    return { leaveId, scheduleId };
  }

  async function createBlockingSchedule({ suffix, date, studentId, taskId }) {
    const scheduleId = `${prefix}-BLOCK-${suffix}`;
    await pool.query(
      `
      INSERT INTO picket_schedules
        (id, schedule_date, day_id, student_id, task_id, status, created_by, updated_by)
      VALUES ($1, $2::date, $3, $4, $5, 'Ditugaskan', $6, $6)
      `,
      [scheduleId, date, new Date(`${date}T00:00:00Z`).getUTCDay(), studentId, taskId, userIds[0]]
    );
    return scheduleId;
  }

  async function setup() {
    await ensurePicketTables();
    const constraintResult = await pool.query(
      `
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'picket_schedules'::regclass
        AND conname IN (
          'picket_schedules_schedule_date_student_id_key',
          'picket_schedules_schedule_date_task_id_key'
        )
      `
    );
    assert.equal(constraintResult.rowCount, 2, "database migration/constraints must be installed before integration tests");

    originalTaskStates = (await pool.query(
      "SELECT id, active FROM picket_tasks WHERE deleted_at IS NULL"
    )).rows;
    await pool.query("UPDATE picket_tasks SET active = FALSE WHERE deleted_at IS NULL");
    await pool.query("DELETE FROM picket_schedules WHERE schedule_date = ANY($1::date[])", [dates]);
    await pool.query("DELETE FROM picket_holidays WHERE holiday_date = ANY($1::date[])", [dates]);
    await pool.query(
      "DELETE FROM picket_schedules WHERE schedule_date BETWEEN $1::date AND $2::date",
      replacementRange
    );
    await pool.query(
      "DELETE FROM picket_holidays WHERE holiday_date BETWEEN $1::date AND $2::date",
      replacementRange
    );

    for (let index = 0; index < userIds.length; index += 1) {
      await pool.query(
        "INSERT INTO users (id, name, initials, role, email, is_active) VALUES ($1, $2, $3, 'mahasiswa', $4, TRUE)",
        [userIds[index], `Picket IT ${index + 1}`, `I${index + 1}`, `${prefix.toLowerCase()}-${index + 1}@example.test`]
      );
      await pool.query(
        "INSERT INTO students (id, user_id, nim, status, tipe) VALUES ($1, $2, $3, 'Aktif', 'Riset')",
        [studentIds[index], userIds[index], `${Date.now()}${index}`]
      );
    }
    for (let index = 0; index < taskIds.length; index += 1) {
      await pool.query(
        "INSERT INTO picket_tasks (id, name, active) VALUES ($1, $2, $3)",
        [taskIds[index], `Picket integration task ${index + 1}`, index < 3]
      );
    }
    for (const studentId of studentIds.slice(0, 3)) {
      await pool.query(
        "INSERT INTO picket_student_days (student_id, day_id, effective_from) VALUES ($1, 0, '2000-01-01')",
        [studentId]
      );
    }

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.authUser = { id: userIds[0], role: "operator", name: "Picket Integration Operator" };
      next();
    });
    app.use("/picket", picketRouter);
    app.use((error, req, res, next) => {
      const status = error.statusCode || error.status || 500;
      const response = { message: error.message };
      if (typeof error.code === "string" && error.code.startsWith("PICKET_")) response.code = error.code;
      res.status(status).json(response);
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }

  async function cleanup() {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.query("DELETE FROM picket_leave_requests WHERE student_id = ANY($1::text[])", [studentIds]).catch(() => {});
    await pool.query("DELETE FROM picket_submissions WHERE student_id = ANY($1::text[])", [studentIds]).catch(() => {});
    await pool.query("DELETE FROM picket_schedules WHERE student_id = ANY($1::text[])", [studentIds]).catch(() => {});
    await pool.query("DELETE FROM picket_student_days WHERE student_id = ANY($1::text[])", [studentIds]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = ANY($1::text[])", [userIds]).catch(() => {});
    await pool.query("DELETE FROM picket_tasks WHERE id = ANY($1::text[])", [taskIds]).catch(() => {});
    for (const task of originalTaskStates) {
      await pool.query("UPDATE picket_tasks SET active = $2 WHERE id = $1", [task.id, task.active]).catch(() => {});
    }
    await pool.end();
  }

  test("picket schedule uniqueness endpoints", async (t) => {
    try {
      await setup();
      let firstAssignments;

      await t.test("generate assigns unique students and tasks", async () => {
        const response = await api("POST", "/picket/schedules/generate", { date: dates[0] });
        assert.equal(response.status, 201, JSON.stringify(response.body));
        firstAssignments = response.body.assignments;
        assert.equal(firstAssignments.length, 3);
        assert.equal(new Set(firstAssignments.map((item) => item.studentId)).size, 3);
        assert.equal(new Set(firstAssignments.map((item) => item.taskId)).size, 3);
      });

      await t.test("generate is idempotent and preserves a submitted schedule", async () => {
        const submitted = firstAssignments[0];
        await pool.query(
          `
          INSERT INTO picket_submissions
            (id, schedule_id, assignment_id, student_id, date, photo_url)
          VALUES ($1, $2, $2, $3, $4::date, '/integration/picket.jpg')
          `,
          [`${prefix}-SUB-1`, submitted.id, submitted.studentId, dates[0]]
        );
        const response = await api("POST", "/picket/schedules/generate", { date: dates[0] });
        assert.equal(response.status, 201);
        assert.deepEqual(response.body.created, []);
        assert.deepEqual(
          response.body.assignments.map((item) => [item.id, item.studentId, item.taskId]).sort(),
          firstAssignments.map((item) => [item.id, item.studentId, item.taskId]).sort()
        );
      });

      await t.test("manual create/update return typed conflicts and tasks can be reused on another date", async () => {
        const taskConflict = await api("POST", "/picket/schedules", {
          date: dates[0], studentId: studentIds[3], taskId: firstAssignments[0].taskId
        });
        assert.equal(taskConflict.status, 409);
        assert.deepEqual(taskConflict.body, {
          code: "PICKET_TASK_ALREADY_ASSIGNED",
          message: "Tugas piket tersebut sudah diberikan kepada mahasiswa lain pada tanggal yang sama."
        });

        const studentConflict = await api("POST", "/picket/schedules", {
          date: dates[0], studentId: firstAssignments[0].studentId, taskId: taskIds[3]
        });
        assert.equal(studentConflict.status, 409);
        assert.equal(studentConflict.body.code, "PICKET_STUDENT_ALREADY_SCHEDULED");

        const updateConflict = await api("PATCH", `/picket/schedules/${firstAssignments[0].id}`, {
          taskId: firstAssignments[1].taskId
        });
        assert.equal(updateConflict.status, 409);
        assert.equal(updateConflict.body.code, "PICKET_TASK_ALREADY_ASSIGNED");

        const reused = await api("POST", "/picket/schedules", {
          date: dates[1], studentId: studentIds[3], taskId: firstAssignments[0].taskId
        });
        assert.equal(reused.status, 201);
      });

      await t.test("insufficient active task capacity rolls back the whole generate", async () => {
        await pool.query("UPDATE picket_tasks SET active = FALSE WHERE id = $1", [taskIds[2]]);
        const response = await api("POST", "/picket/schedules/generate", { date: dates[2] });
        assert.equal(response.status, 422);
        assert.deepEqual(response.body, {
          code: "PICKET_TASK_CAPACITY_INSUFFICIENT",
          message: "Jumlah tugas piket aktif tidak cukup untuk memberikan tugas unik."
        });
        const count = await pool.query(
          "SELECT COUNT(*)::int AS total FROM picket_schedules WHERE schedule_date = $1::date",
          [dates[2]]
        );
        assert.equal(count.rows[0].total, 0);
        await pool.query("UPDATE picket_tasks SET active = TRUE WHERE id = $1", [taskIds[2]]);
      });

      await t.test("concurrent generate produces one unique schedule set", async () => {
        const [left, right] = await Promise.all([
          api("POST", "/picket/schedules/generate", { date: dates[3] }),
          api("POST", "/picket/schedules/generate", { date: dates[3] })
        ]);
        assert.equal(left.status, 201);
        assert.equal(right.status, 201);
        const rows = (await pool.query(
          "SELECT student_id, task_id FROM picket_schedules WHERE schedule_date = $1::date",
          [dates[3]]
        )).rows;
        assert.equal(rows.length, 3);
        assert.equal(new Set(rows.map((row) => row.student_id)).size, 3);
        assert.equal(new Set(rows.map((row) => row.task_id)).size, 3);
        assert.equal(left.body.created.length + right.body.created.length, 3);
      });

      await t.test("leave approval uses the first available replacement date", async () => {
        const { leaveId, scheduleId } = await createPendingLeave({
          suffix: "FIRST",
          originalDate: "2099-02-01",
          studentId: studentIds[0],
          taskId: taskIds[0]
        });
        const response = await api("PATCH", `/picket/leave-requests/${leaveId}/status`, {
          status: "Disetujui"
        });
        assert.equal(response.status, 200);
        assert.equal(response.body.replacementDate, "2099-02-02");
        const original = await pool.query("SELECT status FROM picket_schedules WHERE id = $1", [scheduleId]);
        assert.equal(original.rows[0].status, "Izin");
      });

      await t.test("leave approval skips a date whose task is already assigned", async () => {
        const { leaveId } = await createPendingLeave({
          suffix: "TASK",
          originalDate: "2099-02-08",
          studentId: studentIds[1],
          taskId: taskIds[1]
        });
        await createBlockingSchedule({
          suffix: "TASK-FIRST",
          date: "2099-02-09",
          studentId: studentIds[3],
          taskId: taskIds[1]
        });
        const response = await api("PATCH", `/picket/leave-requests/${leaveId}/status`, {
          status: "Disetujui"
        });
        assert.equal(response.status, 200);
        assert.equal(response.body.replacementDate, "2099-02-10");
      });

      await t.test("leave approval skips a date already occupied by the student", async () => {
        const { leaveId } = await createPendingLeave({
          suffix: "STUDENT",
          originalDate: "2099-02-15",
          studentId: studentIds[2],
          taskId: taskIds[2]
        });
        await createBlockingSchedule({
          suffix: "STUDENT-FIRST",
          date: "2099-02-16",
          studentId: studentIds[2],
          taskId: taskIds[3]
        });
        const response = await api("PATCH", `/picket/leave-requests/${leaveId}/status`, {
          status: "Disetujui"
        });
        assert.equal(response.status, 200);
        assert.equal(response.body.replacementDate, "2099-02-17");
      });

      await t.test("unavailable replacement returns 409 and rolls back the approval", async () => {
        const { leaveId, scheduleId } = await createPendingLeave({
          suffix: "FULL",
          originalDate: "2099-02-22",
          studentId: studentIds[0],
          taskId: taskIds[0]
        });
        const blockedDates = [
          "2099-02-23", "2099-02-24", "2099-02-25", "2099-02-26", "2099-02-27",
          "2099-02-28", "2099-03-02", "2099-03-03", "2099-03-04", "2099-03-05",
          "2099-03-06", "2099-03-07"
        ];
        for (let index = 0; index < blockedDates.length; index += 1) {
          await createBlockingSchedule({
            suffix: `FULL-${index}`,
            date: blockedDates[index],
            studentId: studentIds[3],
            taskId: taskIds[0]
          });
        }

        const response = await api("PATCH", `/picket/leave-requests/${leaveId}/status`, {
          status: "Disetujui"
        });
        assert.equal(response.status, 409);
        assert.deepEqual(response.body, {
          code: "PICKET_REPLACEMENT_DATE_UNAVAILABLE",
          message: "Tidak ditemukan jadwal pengganti dengan tugas yang tersedia dalam 14 hari ke depan."
        });
        const original = await pool.query("SELECT status FROM picket_schedules WHERE id = $1", [scheduleId]);
        assert.equal(original.rows[0].status, "Ditugaskan");
        const leave = await pool.query(
          "SELECT status, replacement_schedule_id, replacement_date FROM picket_leave_requests WHERE id = $1",
          [leaveId]
        );
        assert.deepEqual(leave.rows[0], {
          status: "Menunggu",
          replacement_schedule_id: null,
          replacement_date: null
        });
      });

      await t.test("concurrent approvals sharing a task choose unique replacement dates", async () => {
        const first = await createPendingLeave({
          suffix: "CONCURRENT-A",
          originalDate: "2099-03-08",
          studentId: studentIds[1],
          taskId: taskIds[1]
        });
        const second = await createPendingLeave({
          suffix: "CONCURRENT-B",
          originalDate: "2099-03-07",
          studentId: studentIds[2],
          taskId: taskIds[1]
        });
        const [left, right] = await Promise.all([
          api("PATCH", `/picket/leave-requests/${first.leaveId}/status`, { status: "Disetujui" }),
          api("PATCH", `/picket/leave-requests/${second.leaveId}/status`, { status: "Disetujui" })
        ]);
        assert.equal(left.status, 200);
        assert.equal(right.status, 200);
        assert.notEqual(left.body.replacementScheduleId, right.body.replacementScheduleId);
        assert.deepEqual(
          new Set([left.body.replacementDate, right.body.replacementDate]),
          new Set(["2099-03-09", "2099-03-10"])
        );
        const replacements = await pool.query(
          `
          SELECT schedule_date, COUNT(*)::int AS total
          FROM picket_schedules
          WHERE task_id = $1 AND schedule_date IN ('2099-03-09'::date, '2099-03-10'::date)
          GROUP BY schedule_date
          `,
          [taskIds[1]]
        );
        assert.equal(replacements.rowCount, 2);
        assert.equal(replacements.rows.every((row) => row.total === 1), true);
      });

      await t.test("rejected leave does not create a replacement schedule", async () => {
        const { leaveId, scheduleId } = await createPendingLeave({
          suffix: "REJECTED",
          originalDate: "2099-03-15",
          studentId: studentIds[2],
          taskId: taskIds[2]
        });
        const response = await api("PATCH", `/picket/leave-requests/${leaveId}/status`, {
          status: "Ditolak"
        });
        assert.equal(response.status, 200);
        assert.equal(response.body.status, "Ditolak");
        assert.equal(response.body.replacementScheduleId, null);
        const original = await pool.query("SELECT status FROM picket_schedules WHERE id = $1", [scheduleId]);
        assert.equal(original.rows[0].status, "Ditugaskan");
        const replacements = await pool.query(
          "SELECT COUNT(*)::int AS total FROM picket_schedules WHERE notes = $1",
          [`Jadwal pengganti sementara untuk izin piket ${leaveId}.`]
        );
        assert.equal(replacements.rows[0].total, 0);
      });

      await t.test("new leave request is approved automatically with a replacement", async () => {
        const scheduleId = await createBlockingSchedule({
          suffix: "AUTO-ORIGINAL",
          date: "2099-03-22",
          studentId: studentIds[0],
          taskId: taskIds[2]
        });
        const response = await api("POST", "/picket/leave-requests", {
          scheduleId,
          studentId: studentIds[0],
          date: "2099-03-22",
          reason: "Izin otomatis integration test"
        });
        assert.equal(response.status, 201);
        assert.equal(response.body.status, "Disetujui");
        assert.equal(response.body.replacementDate, "2099-03-23");
        assert.ok(response.body.replacementScheduleId);
        const original = await pool.query("SELECT status FROM picket_schedules WHERE id = $1", [scheduleId]);
        assert.equal(original.rows[0].status, "Izin");
      });
    } finally {
      await cleanup();
    }
  });
}
