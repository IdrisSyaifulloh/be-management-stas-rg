const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.RUN_SCRUM_V2_SUMMARY_INTEGRATION_TESTS === "true" && Boolean(process.env.TEST_DATABASE_URL);

if (!enabled) {
  test("Scrum V2 summary integration tests", { skip: "Set RUN_SCRUM_V2_SUMMARY_INTEGRATION_TESTS=true and TEST_DATABASE_URL." }, () => {});
} else {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "scrum-v2-summary-integration-secret";

  const http = require("node:http");
  const express = require("express");
  const router = require("../routes/api/research");
  const { pool } = require("../db/pool");
  const { ensureResearchBoardTables } = require("../utils/researchBoardStore");
  const { prepareFreshScrumV2Database } = require("./helpers/prepareScrumV2Database");

  const prefix = `SCRUM-V2-SUMMARY-${process.pid}-${Date.now()}`;
  const projectId = `${prefix}-PROJECT`;
  const sprintId = `${prefix}-REVIEW`;
  const targetSprintId = `${prefix}-TARGET`;
  const legacySprintId = `${prefix}-LEGACY-CLOSED`;
  const managerId = `${prefix}-MANAGER`;
  const studentAId = `${prefix}-STUDENT-A`;
  const studentBId = `${prefix}-STUDENT-B`;
  const webId = `${prefix}-WEB`;
  const iotId = `${prefix}-IOT`;
  const tasks = {
    done: `${prefix}-TASK-DONE`,
    carry: `${prefix}-TASK-CARRY`,
    cancel: `${prefix}-TASK-CANCEL`,
    backlog: `${prefix}-TASK-BACKLOG`
  };
  let server;
  let baseUrl;

  function headers(role = "operator", userId = managerId) {
    return { "x-test-role": role, "x-test-user-id": userId };
  }

  async function api(method, path, body, requestHeaders = headers()) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...requestHeaders },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  }

  async function setup() {
    await prepareFreshScrumV2Database(pool, process.env.TEST_DATABASE_URL);
    await ensureResearchBoardTables();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM research_projects WHERE id = $1", [projectId]);
      await client.query("DELETE FROM users WHERE id = ANY($1::text[])", [[managerId, studentAId, studentBId]]);
      await client.query(
        `INSERT INTO users (id, name, initials, role, email, is_active)
         VALUES ($1,'Summary Manager','SM','operator',$4,TRUE),
                ($2,'Summary Student A','SA','mahasiswa',$5,TRUE),
                ($3,'Summary Student B','SB','mahasiswa',$6,TRUE)`,
        [managerId, studentAId, studentBId, `${managerId}@test.local`, `${studentAId}@test.local`, `${studentBId}@test.local`]
      );
      await client.query("INSERT INTO research_projects (id,title,status) VALUES ($1,'Summary Integration Project','Aktif')", [projectId]);
      await client.query(
        `INSERT INTO research_memberships (project_id,user_id,member_type,peran,status)
         VALUES ($1,$2,'Mahasiswa','Anggota','Aktif'),($1,$3,'Mahasiswa','Anggota','Aktif')`,
        [projectId, studentAId, studentBId]
      );
      await client.query(
        `INSERT INTO research_divisions (id,project_id,name,sort_order)
         VALUES ($2,$1,'Web',1),($3,$1,'IoT',2)`,
        [projectId, webId, iotId]
      );
      await client.query(
        `INSERT INTO research_sprints (id,project_id,name,status,closed_at)
         VALUES ($2,$1,'Review Sprint','review',NULL),($3,$1,'Target Sprint','planning',NULL),($4,$1,'Legacy Closed','closed',NOW())`,
        [projectId, sprintId, targetSprintId, legacySprintId]
      );
      const taskRows = [
        [tasks.done, "Done task", "DONE", webId, studentAId, 5, 100],
        [tasks.carry, "Carry task", "DOING", webId, studentAId, 3, 40],
        [tasks.cancel, "Cancel task", "REVIEW", iotId, studentBId, 8, 60],
        [tasks.backlog, "Backlog task", "DOING", iotId, studentBId, 2, 20]
      ];
      for (let index = 0; index < taskRows.length; index += 1) {
        const [taskId, title, status, divisionId, userId, points, progress] = taskRows[index];
        await client.query(
          `INSERT INTO research_board_tasks (id,project_id,title,status,progress,sort_order,division_id,sprint_id,story_points)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [taskId, projectId, title, status, progress, index, divisionId, sprintId, points]
        );
        await client.query("INSERT INTO research_board_task_assignees (task_id,user_id) VALUES ($1,$2)", [taskId, userId]);
        await client.query(
          `INSERT INTO research_sprint_task_assignments
             (id,sprint_id,task_id,division_id_at_assignment,division_name_at_assignment,story_points_at_assignment,status_at_assignment)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [`${prefix}-LEDGER-${index}`, sprintId, taskId, divisionId, divisionId === webId ? "Web" : "IoT", points, status]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.authUser = { id: req.headers["x-test-user-id"] || managerId, role: req.headers["x-test-role"] || "operator" };
      next();
    });
    app.use("/research", router);
    app.use((error, req, res, next) => {
      res.status(error.statusCode || error.status || 500).json({ message: error.message, ...(error.code && !/^\d+$/.test(String(error.code)) ? { code: error.code } : {}) });
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }

  async function cleanup() {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.query("DELETE FROM research_projects WHERE id = $1", [projectId]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = ANY($1::text[])", [[managerId, studentAId, studentBId]]).catch(() => {});
    await pool.end();
  }

  test("Scrum V2 Sprint review, summary, evaluation, outcomes, and finalization", async (t) => {
    try {
      await setup();

      await t.test("aggregate uses historical ledger and exposes division/member metrics", async () => {
        const response = await api("GET", `/research/${projectId}/sprints/${sprintId}/summary`);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.overview.totalTasks, 4);
        assert.equal(response.body.overview.completedTasks, 1);
        assert.equal(response.body.overview.plannedStoryPoints, 18);
        assert.equal(response.body.overview.completedStoryPoints, 5);
        assert.equal(response.body.divisionResults.find((row) => row.divisionName === "Web").totalTasks, 2);
        assert.equal(response.body.divisionResults.find((row) => row.divisionName === "IoT").unfinishedTasks, 2);
        assert.deepEqual(response.body.requiredEvaluations.map((row) => row.id).sort(), [studentAId, studentBId].sort());
        assert.equal(response.body.memberMetrics.find((row) => row.id === studentAId).assignedTasks, 2);
        assert.equal(response.body.canFinalize, false);
      });

      await t.test("summary, meeting, attendees, score validation, and self-evaluation authorization", async () => {
        const summary = await api("PUT", `/research/${projectId}/sprints/${sprintId}/summary`, {
          summary: "Sprint achieved the planned prototype milestone.",
          achievements: "Prototype completed",
          challenges: "Hardware lead time",
          lessonsLearned: "Keep a buffer",
          nextSprintPlan: "Field validation"
        });
        assert.equal(summary.status, 200);
        const meeting = await api("PUT", `/research/${projectId}/sprints/${sprintId}/review-meeting`, {
          meetingDate: "2026-09-10",
          startTime: "10:00",
          location: "Lab",
          chairUserId: managerId,
          agenda: "Review",
          notes: "Discussed delivery and quality.",
          attendeeUserIds: [studentAId, studentBId]
        });
        assert.equal(meeting.status, 200);
        assert.equal(meeting.body.meeting.attendees.length, 2);
        const invalid = await api("PUT", `/research/${projectId}/sprints/${sprintId}/evaluations/${studentAId}`, { taskCompletion: 11, quality: 8, timeliness: 8, collaboration: 8, initiative: 8, notes: "x" });
        assert.equal(invalid.status, 400);
        const self = await api("PUT", `/research/${projectId}/sprints/${sprintId}/evaluations/${managerId}`, { taskCompletion: 8, quality: 8, timeliness: 8, collaboration: 8, initiative: 8, notes: "x" });
        assert.equal(self.status, 403);
        for (const userId of [studentAId, studentBId]) {
          const evaluation = await api("PUT", `/research/${projectId}/sprints/${sprintId}/evaluations/${userId}`, { taskCompletion: 8, quality: 9, timeliness: 7, collaboration: 10, initiative: 6, notes: `Evaluation ${userId}` });
          assert.equal(evaluation.status, 200, JSON.stringify(evaluation.body));
          assert.equal(evaluation.body.evaluation.overallScore, 8);
        }
      });

      await t.test("pending outcome, invalid target, concurrent outcome, and readiness", async () => {
        const before = await api("GET", `/research/${projectId}/sprints/${sprintId}/summary`);
        assert.equal(before.body.canFinalize, false);
        assert.ok(before.body.finalizationErrors.some((error) => error.code === "OUTCOME_REQUIRED"));
        const invalid = await api("PUT", `/research/${projectId}/sprints/${sprintId}/tasks/${tasks.carry}/outcome`, { outcome: "carry_over", targetSprintId: legacySprintId });
        assert.equal(invalid.status, 409);
        const outcomes = await Promise.all([
          api("PUT", `/research/${projectId}/sprints/${sprintId}/tasks/${tasks.carry}/outcome`, { outcome: "carry_over", targetSprintId }),
          api("PUT", `/research/${projectId}/sprints/${sprintId}/tasks/${tasks.carry}/outcome`, { outcome: "carry_over", targetSprintId })
        ]);
        assert.deepEqual(outcomes.map((row) => row.status).sort(), [200, 200]);
        const cancel = await api("PUT", `/research/${projectId}/sprints/${sprintId}/tasks/${tasks.cancel}/outcome`, { outcome: "cancelled" });
        assert.equal(cancel.status, 200);
        const backlog = await api("PUT", `/research/${projectId}/sprints/${sprintId}/tasks/${tasks.backlog}/outcome`, { outcome: "backlog" });
        assert.equal(backlog.status, 200);
        const ready = await api("GET", `/research/${projectId}/sprints/${sprintId}/summary`);
        assert.equal(ready.body.canFinalize, true);
      });

      await t.test("mid-finalization failure rolls back every partial change", async () => {
        const snapshot = async () => ({
          sprint: (await pool.query("SELECT status, review_started_at, closed_at FROM research_sprints WHERE id = $1", [sprintId])).rows[0],
          tasks: (await pool.query("SELECT id, sprint_id, cancelled_at, cancelled_by FROM research_board_tasks WHERE id = ANY($1::text[]) ORDER BY id", [Object.values(tasks)])).rows,
          assignments: (await pool.query("SELECT sprint_id, task_id, division_id_at_assignment, division_name_at_assignment, story_points_at_assignment, status_at_assignment, outcome, target_sprint_id, status_at_close, progress_at_close, closed_at FROM research_sprint_task_assignments WHERE task_id = ANY($1::text[]) ORDER BY sprint_id, task_id", [Object.values(tasks)])).rows,
          summary: (await pool.query("SELECT is_finalized, finalized_by, finalized_at FROM research_sprint_summaries WHERE sprint_id = $1", [sprintId])).rows[0]
        });
        const before = await snapshot();
        const originalConnect = pool.connect.bind(pool);
        pool.connect = async (...args) => {
          const client = await originalConnect(...args);
          const originalQuery = client.query.bind(client);
          let injected = false;
          const wrappedClient = Object.create(client);
          wrappedClient.query = async (text, params) => {
            if (!injected && typeof text === "string" && text.includes("UPDATE research_board_tasks SET sprint_id = $2")) {
              injected = true;
              throw new Error("Injected finalization failure");
            }
            return originalQuery(text, params);
          };
          wrappedClient.release = client.release.bind(client);
          return wrappedClient;
        };
        try {
          assert.equal((await api("POST", `/research/${projectId}/sprints/${sprintId}/finalize`)).status, 500);
        } finally {
          pool.connect = originalConnect;
        }
        assert.deepEqual(await snapshot(), before);
      });

      await t.test("concurrent finalize is idempotent and preserves all histories", async () => {
        const results = await Promise.all([
          api("POST", `/research/${projectId}/sprints/${sprintId}/finalize`),
          api("POST", `/research/${projectId}/sprints/${sprintId}/finalize`)
        ]);
        assert.deepEqual(results.map((row) => row.status).sort(), [200, 409]);
        const source = await pool.query("SELECT task_id, outcome, target_sprint_id, status_at_close, progress_at_close, story_points_at_assignment, division_id_at_assignment FROM research_sprint_task_assignments WHERE sprint_id = $1 ORDER BY task_id", [sprintId]);
        assert.equal(source.rowCount, 4);
        assert.deepEqual(source.rows.map((row) => row.outcome).sort(), ["backlog", "cancelled", "carry_over", "done"]);
        const carryLedger = source.rows.find((row) => row.task_id === tasks.carry);
        assert.equal(carryLedger.status_at_close, "DOING");
        assert.equal(carryLedger.progress_at_close, 40);
        assert.equal(carryLedger.story_points_at_assignment, 3);
        assert.equal(carryLedger.division_id_at_assignment, webId);
        assert.equal(carryLedger.outcome, "carry_over");
        assert.equal(carryLedger.target_sprint_id, targetSprintId);
        const target = await pool.query("SELECT COUNT(*)::int AS count FROM research_sprint_task_assignments WHERE sprint_id = $1", [targetSprintId]);
        assert.equal(target.rows[0].count, 1);
        const pointers = await pool.query("SELECT id, sprint_id, cancelled_at IS NOT NULL AS cancelled FROM research_board_tasks WHERE id = ANY($1::text[])", [Object.values(tasks)]);
        assert.equal(pointers.rows.find((row) => row.id === tasks.carry).sprint_id, targetSprintId);
        assert.equal(pointers.rows.find((row) => row.id === tasks.done).sprint_id, sprintId);
        assert.equal(pointers.rows.find((row) => row.id === tasks.cancel).sprint_id, null);
        assert.equal(pointers.rows.find((row) => row.id === tasks.cancel).cancelled, true);
        assert.equal(pointers.rows.find((row) => row.id === tasks.backlog).sprint_id, null);
        assert.equal(pointers.rows.find((row) => row.id === tasks.backlog).cancelled, false);
        const closed = await pool.query("SELECT status, closed_at FROM research_sprints WHERE id = $1", [sprintId]);
        assert.equal(closed.rows[0].status, "closed");
        assert.ok(closed.rows[0].closed_at);
      });

      await t.test("closed and legacy Sprint remain readable, edits are rejected, target can start", async () => {
        const before = await api("GET", `/research/${projectId}/sprints/${sprintId}/summary`);
        assert.equal(before.status, 200);
        assert.equal(before.body.sprint.status, "closed");
        assert.equal(before.body.summary.isFinalized, true);
        const carryBefore = before.body.unfinishedWork.find((row) => row.taskId === tasks.carry);
        assert.equal(carryBefore.status, "DOING");
        assert.equal(carryBefore.progress, 40);
        assert.equal(carryBefore.storyPoints, 3);
        assert.equal(carryBefore.divisionId, webId);
        const edit = await api("PUT", `/research/${projectId}/sprints/${sprintId}/summary`, { summary: "mutate" });
        assert.equal(edit.status, 409);
        const legacy = await api("GET", `/research/${projectId}/sprints/${legacySprintId}/summary`);
        assert.equal(legacy.status, 200);
        assert.equal(legacy.body.summary, null);
        const startTarget = await api("PATCH", `/research/${projectId}/sprints/${targetSprintId}`, { status: "active" });
        assert.equal(startTarget.status, 200);
        const mutateCurrent = await api("PATCH", `/research/${projectId}/board/tasks/${tasks.carry}`, {
          status: "DONE",
          progress: 100,
          storyPoints: 21,
          divisionId: iotId
        });
        assert.equal(mutateCurrent.status, 200, JSON.stringify(mutateCurrent.body));
        assert.equal(mutateCurrent.body.task.status, "DONE");
        assert.equal(mutateCurrent.body.task.storyPoints, 21);
        assert.equal(mutateCurrent.body.task.divisionId, iotId);

        const after = await api("GET", `/research/${projectId}/sprints/${sprintId}/summary`);
        assert.equal(after.status, 200);
        assert.deepEqual(after.body.overview, before.body.overview);
        assert.deepEqual(after.body.divisionResults, before.body.divisionResults);
        assert.equal(after.body.overview.completedTasks, 1);
        assert.equal(after.body.overview.completedStoryPoints, 5);
        assert.equal(after.body.overview.unfinishedTasks, 3);
        assert.equal(after.body.overview.completionPercentage, before.body.overview.completionPercentage);
        const carryAfter = after.body.unfinishedWork.find((row) => row.taskId === tasks.carry);
        assert.equal(carryAfter.status, "DOING");
        assert.equal(carryAfter.progress, 40);
        assert.equal(carryAfter.storyPoints, 3);
        assert.equal(carryAfter.divisionId, webId);
        assert.equal(carryAfter.outcome, "carry_over");
        assert.equal(after.body.completedWork.some((row) => row.taskId === tasks.carry), false);
      });
    } finally {
      await cleanup();
    }
  });
}
