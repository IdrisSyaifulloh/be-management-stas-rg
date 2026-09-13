const test = require("node:test");
const assert = require("node:assert/strict");

const integrationEnabled =
  process.env.RUN_SCRUM_V2_INTEGRATION_TESTS === "true" &&
  Boolean(process.env.TEST_DATABASE_URL);

if (!integrationEnabled) {
  test("Scrum V2 core database integration tests", {
    skip: "Set RUN_SCRUM_V2_INTEGRATION_TESTS=true and TEST_DATABASE_URL."
  }, () => {});
} else {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "scrum-v2-integration-test-secret";

  const http = require("node:http");
  const express = require("express");
  const researchRouter = require("../routes/api/research");
  const { pool } = require("../db/pool");
  const { ensureResearchBoardTables } = require("../utils/researchBoardStore");
  const { prepareFreshScrumV2Database } = require("./helpers/prepareScrumV2Database");

  const prefix = `SCRUM-V2-IT-${process.pid}-${Date.now()}`;
  const userIds = {
    operator: `${prefix}-OPERATOR`,
    student: `${prefix}-STUDENT`,
    outsider: `${prefix}-OUTSIDER`
  };
  const projectIds = {
    primary: `${prefix}-PROJECT-A`,
    secondary: `${prefix}-PROJECT-B`,
    sprintRace: `${prefix}-PROJECT-C`,
    taskRace: `${prefix}-PROJECT-D`
  };
  let server;
  let baseUrl;

  function authHeaders(role = "operator", userId = userIds.operator) {
    return { "x-test-role": role, "x-test-user-id": userId };
  }

  async function api(method, path, body = null, headers = authHeaders()) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body == null ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  }

  async function createSprint(projectId, id, name = id) {
    return api("POST", `/research/${projectId}/sprints`, { id, name });
  }

  async function setup() {
    await prepareFreshScrumV2Database(pool, process.env.TEST_DATABASE_URL);
    await ensureResearchBoardTables();
    for (const [roleName, userId] of Object.entries(userIds)) {
      await pool.query(
        `
        INSERT INTO users (id, name, initials, role, email, is_active)
        VALUES ($1, $2, $3, $4, $5, TRUE)
        `,
        [
          userId,
          `Scrum V2 ${roleName}`,
          roleName.slice(0, 2).toUpperCase(),
          roleName === "operator" ? "operator" : "mahasiswa",
          `${userId.toLowerCase()}@example.test`
        ]
      );
    }
    for (const [key, projectId] of Object.entries(projectIds)) {
      await pool.query(
        "INSERT INTO research_projects (id, title, short_title, status) VALUES ($1, $2, $3, 'Aktif')",
        [projectId, `Scrum V2 ${key}`, `V2 ${key}`]
      );
    }
    await pool.query(
      "INSERT INTO research_projects (id, title, short_title, status) VALUES ('SCRUM-V2-MIGRATION-PROJECT', 'Migration fixture', 'Migration', 'Aktif')"
    );
    await pool.query(
      "INSERT INTO research_sprints (id, project_id, name, status, closed_at) VALUES ('SCRUM-V2-LEGACY-SPRINT', 'SCRUM-V2-MIGRATION-PROJECT', 'Legacy Sprint', 'closed', NOW())"
    );
    await pool.query(
      `
      INSERT INTO research_memberships (project_id, user_id, member_type, peran, status)
      VALUES ($1, $2, 'Mahasiswa', 'Anggota', 'Aktif')
      `,
      [projectIds.primary, userIds.student]
    );

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.authUser = {
        id: req.headers["x-test-user-id"] || userIds.operator,
        role: req.headers["x-test-role"] || "operator"
      };
      next();
    });
    app.use("/research", researchRouter);
    app.use((error, req, res, next) => {
      const status = error.statusCode || error.status || 500;
      const response = { message: error.message };
      if (error.code && !/^\d+$/.test(String(error.code))) response.code = error.code;
      res.status(status).json(response);
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }

  async function cleanup() {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.query("DELETE FROM research_projects WHERE id = ANY($1::text[])", [Object.values(projectIds)]).catch(() => {});
    await pool.query("DELETE FROM research_projects WHERE id = 'SCRUM-V2-MIGRATION-PROJECT'").catch(() => {});
    await pool.query("DELETE FROM users WHERE id = ANY($1::text[])", [Object.values(userIds)]).catch(() => {});
    await pool.end();
  }

  test("Scrum V2 backend core", async (t) => {
    try {
      await setup();
      let webDivision;
      let secondaryWebDivision;
      const sprintA = `${prefix}-SPRINT-A`;
      const sprintB = `${prefix}-SPRINT-B`;
      const assignedTask = `${prefix}-TASK-ASSIGNED`;

      await t.test("Division API enforces project uniqueness and authorization", async () => {
        const web = await api("POST", `/research/${projectIds.primary}/divisions`, {
          name: "Web",
          sortOrder: 1
        });
        const iot = await api("POST", `/research/${projectIds.primary}/divisions`, {
          name: "IoT",
          sortOrder: 2
        });
        assert.equal(web.status, 201);
        assert.equal(iot.status, 201);
        webDivision = web.body.division;
        assert.equal(webDivision.projectId, projectIds.primary);
        assert.equal(webDivision.project_id, projectIds.primary);
        assert.equal(webDivision.sortOrder, 1);

        const duplicate = await api("POST", `/research/${projectIds.primary}/divisions`, { name: " web " });
        assert.equal(duplicate.status, 409);

        const otherProject = await api("POST", `/research/${projectIds.secondary}/divisions`, { name: "Web" });
        assert.equal(otherProject.status, 201);
        secondaryWebDivision = otherProject.body.division;

        const memberRead = await api(
          "GET",
          `/research/${projectIds.primary}/divisions`,
          null,
          authHeaders("mahasiswa", userIds.student)
        );
        assert.equal(memberRead.status, 200);
        assert.equal(memberRead.body.length, 2);

        const studentCreate = await api(
          "POST",
          `/research/${projectIds.primary}/divisions`,
          { name: "Forbidden" },
          authHeaders("mahasiswa", userIds.student)
        );
        assert.equal(studentCreate.status, 403);

        const crossProjectRead = await api(
          "GET",
          `/research/${projectIds.secondary}/divisions`,
          null,
          authHeaders("mahasiswa", userIds.student)
        );
        assert.equal(crossProjectRead.status, 403);
      });

      await t.test("Task Division and Sprint assignment are validated and exposed", async () => {
        assert.equal((await createSprint(projectIds.primary, sprintA, "Sprint A")).status, 201);
        assert.equal((await createSprint(projectIds.primary, sprintB, "Sprint B")).status, 201);

        const legacyTask = await api("POST", `/research/${projectIds.primary}/board/tasks`, {
          id: `${prefix}-TASK-LEGACY`,
          title: "Legacy without Division"
        });
        assert.equal(legacyTask.status, 201);
        assert.equal(legacyTask.body.task.divisionId, null);

        const assigned = await api("POST", `/research/${projectIds.primary}/board/tasks`, {
          id: assignedTask,
          title: "Division task",
          divisionId: webDivision.id,
          sprintId: sprintA,
          storyPoints: 5,
          assigneeIds: [userIds.student]
        });
        assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
        assert.equal(assigned.body.task.divisionId, webDivision.id);
        assert.equal(assigned.body.task.divisionName, "Web");
        assert.equal(assigned.body.task.divisionIsActive, true);

        const ledger = await pool.query(
          "SELECT * FROM research_sprint_task_assignments WHERE sprint_id = $1 AND task_id = $2",
          [sprintA, assignedTask]
        );
        assert.equal(ledger.rowCount, 1);
        assert.equal(ledger.rows[0].division_name_at_assignment, "Web");
        assert.equal(ledger.rows[0].story_points_at_assignment, 5);

        const crossDivision = await api("POST", `/research/${projectIds.primary}/board/tasks`, {
          id: `${prefix}-TASK-CROSS-DIVISION`,
          title: "Invalid division",
          divisionId: secondaryWebDivision.id
        });
        assert.equal(crossDivision.status, 400);

        const otherSprint = `${prefix}-SPRINT-OTHER-PROJECT`;
        assert.equal((await createSprint(projectIds.secondary, otherSprint)).status, 201);
        const crossSprint = await api("PATCH", `/research/${projectIds.primary}/board/tasks/${assignedTask}`, {
          sprintId: otherSprint
        });
        assert.equal(crossSprint.status, 400);

        const studentDivisionEdit = await api(
          "PATCH",
          `/research/${projectIds.primary}/board/tasks/${assignedTask}`,
          { divisionId: webDivision.id },
          authHeaders("mahasiswa", userIds.student)
        );
        assert.equal(studentDivisionEdit.status, 403);
      });

      await t.test("my-scrum-tasks preserves assignment scope and Division DTO", async () => {
        const response = await api(
          "GET",
          `/research/my-scrum-tasks?projectId=${projectIds.primary}`,
          null,
          authHeaders("mahasiswa", userIds.student)
        );
        assert.equal(response.status, 200);
        assert.equal(response.body.length, 1);
        assert.equal(response.body[0].id, assignedTask);
        assert.equal(response.body[0].divisionId, webDivision.id);
        assert.equal(response.body[0].division_id, webDivision.id);
        assert.equal(response.body[0].divisionName, "Web");
      });

      await t.test("inactive Division remains readable but cannot receive new tasks", async () => {
        const disabled = await api("PATCH", `/research/${projectIds.primary}/divisions/${webDivision.id}`, {
          isActive: false
        });
        assert.equal(disabled.status, 200);

        const detail = await api("GET", `/research/${projectIds.primary}/board/tasks/${assignedTask}`);
        assert.equal(detail.status, 200);
        assert.equal(detail.body.divisionName, "Web");
        assert.equal(detail.body.divisionIsActive, false);

        const rejected = await api("POST", `/research/${projectIds.primary}/board/tasks`, {
          title: "Cannot use inactive division",
          divisionId: webDivision.id
        });
        assert.equal(rejected.status, 409);
      });

      await t.test("parallel Task Sprint assignments keep a unique history ledger", async () => {
        const sprintOne = `${prefix}-TASK-RACE-SPRINT-1`;
        const sprintTwo = `${prefix}-TASK-RACE-SPRINT-2`;
        const taskId = `${prefix}-TASK-RACE`;
        assert.equal((await createSprint(projectIds.taskRace, sprintOne)).status, 201);
        assert.equal((await createSprint(projectIds.taskRace, sprintTwo)).status, 201);
        assert.equal((await api("POST", `/research/${projectIds.taskRace}/board/tasks`, {
          id: taskId,
          title: "Concurrent assignment",
          sprintId: sprintOne
        })).status, 201);

        const results = await Promise.all([
          api("PATCH", `/research/${projectIds.taskRace}/board/tasks/${taskId}`, { sprintId: sprintOne }),
          api("PATCH", `/research/${projectIds.taskRace}/board/tasks/${taskId}`, { sprintId: sprintTwo })
        ]);
        assert.deepEqual(results.map((result) => result.status).sort(), [200, 200]);

        const task = await pool.query("SELECT sprint_id FROM research_board_tasks WHERE id = $1", [taskId]);
        assert.ok([sprintOne, sprintTwo].includes(task.rows[0].sprint_id));
        const ledger = await pool.query(
          `
          SELECT sprint_id, task_id, COUNT(*)::int AS total
          FROM research_sprint_task_assignments
          WHERE task_id = $1
          GROUP BY sprint_id, task_id
          ORDER BY sprint_id
          `,
          [taskId]
        );
        assert.equal(ledger.rowCount, 2);
        assert.equal(ledger.rows.every((row) => row.total === 1), true);
      });

      await t.test("Sprint lifecycle ends in review and blocks the next Sprint", async () => {
        const started = await api("PATCH", `/research/${projectIds.primary}/sprints/${sprintA}`, {
          status: "active"
        });
        assert.equal(started.status, 200);
        assert.equal(started.body.sprint.status, "active");

        const ended = await api("PATCH", `/research/${projectIds.primary}/sprints/${sprintA}`, {
          status: "completed"
        });
        assert.equal(ended.status, 200);
        assert.equal(ended.body.sprint.status, "review");
        assert.ok(ended.body.sprint.reviewStartedAt);

        const blocked = await api("PATCH", `/research/${projectIds.primary}/sprints/${sprintB}`, {
          status: "active"
        });
        assert.equal(blocked.status, 409);
        assert.equal(blocked.body.code, "SCRUM_SPRINT_REVIEW_PENDING");

        const reviewStatusEdit = await api(
          "PATCH",
          `/research/${projectIds.primary}/board/tasks/${assignedTask}/status`,
          { status: "DONE" }
        );
        assert.equal(reviewStatusEdit.status, 409);
        assert.equal(reviewStatusEdit.body.code, "SCRUM_SPRINT_READ_ONLY");
        const reviewGeneralEdit = await api(
          "PATCH",
          `/research/${projectIds.primary}/board/tasks/${assignedTask}`,
          { title: "Must remain frozen", progress: 99 }
        );
        assert.equal(reviewGeneralEdit.status, 409);
        assert.equal(reviewGeneralEdit.body.code, "SCRUM_SPRINT_READ_ONLY");
        const unauthorizedReviewEdit = await api(
          "PATCH",
          `/research/${projectIds.primary}/board/tasks/${assignedTask}/status`,
          { status: "DONE" },
          authHeaders("mahasiswa", userIds.outsider)
        );
        assert.equal(unauthorizedReviewEdit.status, 403);
        const deleteReview = await api("DELETE", `/research/${projectIds.primary}/sprints/${sprintA}`);
        assert.equal(deleteReview.status, 409);
        const deleteReviewTask = await api(
          "DELETE",
          `/research/${projectIds.primary}/board/tasks/${assignedTask}`
        );
        assert.equal(deleteReviewTask.status, 409);
        assert.equal(deleteReviewTask.body.code, "SCRUM_SPRINT_READ_ONLY");

        await pool.query("UPDATE research_sprints SET status = 'closed', closed_at = NOW() WHERE id = $1", [sprintA]);
        const closedStatusEdit = await api(
          "PATCH",
          `/research/${projectIds.primary}/board/tasks/${assignedTask}/status`,
          { status: "DONE" }
        );
        assert.equal(closedStatusEdit.status, 409);
        assert.equal(closedStatusEdit.body.code, "SCRUM_SPRINT_READ_ONLY");
        const closedGeneralEdit = await api(
          "PATCH",
          `/research/${projectIds.primary}/board/tasks/${assignedTask}`,
          { description: "Must remain frozen" }
        );
        assert.equal(closedGeneralEdit.status, 409);
        assert.equal(closedGeneralEdit.body.code, "SCRUM_SPRINT_READ_ONLY");
        const deleteClosedTask = await api(
          "DELETE",
          `/research/${projectIds.primary}/board/tasks/${assignedTask}`
        );
        assert.equal(deleteClosedTask.status, 409);
        assert.equal(deleteClosedTask.body.code, "SCRUM_SPRINT_READ_ONLY");

        await pool.query("UPDATE research_board_tasks SET sprint_id = NULL WHERE id = $1", [assignedTask]);
        const backlogEdit = await api(
          "PATCH",
          `/research/${projectIds.primary}/board/tasks/${assignedTask}`,
          { title: "Editable backlog history", storyPoints: 8 }
        );
        assert.equal(backlogEdit.status, 200, JSON.stringify(backlogEdit.body));
        assert.equal(backlogEdit.body.task.title, "Editable backlog history");
        assert.equal(backlogEdit.body.task.storyPoints, 8);

        const startNext = await api("PATCH", `/research/${projectIds.primary}/sprints/${sprintB}`, { status: "active" });
        assert.equal(startNext.status, 200, JSON.stringify(startNext.body));
        const carryOverEdit = await api(
          "PATCH",
          `/research/${projectIds.primary}/board/tasks/${assignedTask}`,
          { sprintId: sprintB, title: "Editable in active Sprint" }
        );
        assert.equal(carryOverEdit.status, 200, JSON.stringify(carryOverEdit.body));
        const activeStatusEdit = await api(
          "PATCH",
          `/research/${projectIds.primary}/board/tasks/${assignedTask}/status`,
          { status: "DOING" }
        );
        assert.equal(activeStatusEdit.status, 200, JSON.stringify(activeStatusEdit.body));
        const preservedLedger = await pool.query(
          "SELECT 1 FROM research_sprint_task_assignments WHERE sprint_id = $1 AND task_id = $2",
          [sprintA, assignedTask]
        );
        assert.equal(preservedLedger.rowCount, 1);
        const planningDelete = `${prefix}-SPRINT-DELETE`;
        assert.equal((await createSprint(projectIds.primary, planningDelete)).status, 201);
        assert.equal((await api("DELETE", `/research/${projectIds.primary}/sprints/${planningDelete}`)).status, 200);
      });

      await t.test("parallel Sprint activation yields exactly one active Sprint", async () => {
        const sprintOne = `${prefix}-RACE-SPRINT-1`;
        const sprintTwo = `${prefix}-RACE-SPRINT-2`;
        assert.equal((await createSprint(projectIds.sprintRace, sprintOne)).status, 201);
        assert.equal((await createSprint(projectIds.sprintRace, sprintTwo)).status, 201);

        const results = await Promise.all([
          api("PATCH", `/research/${projectIds.sprintRace}/sprints/${sprintOne}`, { status: "active" }),
          api("PATCH", `/research/${projectIds.sprintRace}/sprints/${sprintTwo}`, { status: "active" })
        ]);
        assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);

        const rows = await pool.query(
          "SELECT id, status FROM research_sprints WHERE project_id = $1 ORDER BY id",
          [projectIds.sprintRace]
        );
        assert.equal(rows.rows.filter((row) => row.status === "active").length, 1);
        assert.equal(rows.rows.filter((row) => row.status === "planning").length, 1);
        assert.equal(rows.rows.some((row) => row.status === "closed"), false);
      });

      await t.test("migrated closed Sprint is readable and immutable", async () => {
        const list = await api("GET", "/research/SCRUM-V2-MIGRATION-PROJECT/sprints");
        assert.equal(list.status, 200);
        const legacy = list.body.find((sprint) => sprint.id === "SCRUM-V2-LEGACY-SPRINT");
        assert.equal(legacy.status, "closed");
        assert.ok(legacy.closedAt);

        const patch = await api("PATCH", "/research/SCRUM-V2-MIGRATION-PROJECT/sprints/SCRUM-V2-LEGACY-SPRINT", {
          name: "Must not change"
        });
        assert.equal(patch.status, 409);
        assert.equal(patch.body.code, "SCRUM_SPRINT_CLOSED");
      });
    } finally {
      await cleanup();
    }
  });
}
