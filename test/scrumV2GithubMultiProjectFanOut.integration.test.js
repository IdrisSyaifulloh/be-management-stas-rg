const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const http = require("node:http");
const express = require("express");

const testDbUrl = process.env.TEST_DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5433/stasrg_test_suite";
const runDbSuite = Boolean(
  process.env.RUN_SCRUM_V2_GITHUB_INTEGRATION_TESTS === "true" ||
  process.env.TEST_DATABASE_URL ||
  process.env.RUN_ALL_INTEGRATION_TESTS === "true"
);

test("Multi-Research GitHub Repository Fan-Out Suite", { skip: !runDbSuite && "Set TEST_DATABASE_URL to run DB integration suite." }, async (t) => {
  process.env.DATABASE_URL = testDbUrl;
  process.env.NODE_ENV = "test";
  const { pool } = require("../db/pool");
  const { prepareFreshScrumV2Database } = require("./helpers/prepareScrumV2Database");
  const { ensureResearchBoardTables } = require("../utils/researchBoardStore");
  const researchRouter = require("../routes/api/research");
  const githubRouter = require("../routes/api/githubIntegration");

  const p = `FANOUT-${Date.now()}`;
  const ids = {
    projA: `${p}-PA`,
    projB: `${p}-PB`,
    repoA: `${p}-REPO-A`,
    repoB: `${p}-REPO-B`,
    manager: `${p}-MGR`,
    taskA: `${p}-TA`,
    taskB: `${p}-TB`
  };

  process.env.GITHUB_WEBHOOK_SECRET = "fanout-webhook-secret";

  let server;
  let base;

  try {
    await prepareFreshScrumV2Database(pool, testDbUrl);
    await ensureResearchBoardTables();

    // Seed Manager user
    await pool.query(
      "INSERT INTO users(id, name, initials, role, email, is_active) VALUES ($1, 'Manager User', 'MU', 'operator', $2, true)",
      [ids.manager, `${ids.manager}@test.local`]
    );

    // Seed Research Project A and Project B
    await pool.query(
      "INSERT INTO research_projects(id, title, status) VALUES ($1, 'Research Project A', 'Aktif'), ($2, 'Research Project B', 'Aktif')",
      [ids.projA, ids.projB]
    );

    // Seed Task in Project A (TASK-100) and Task in Project B (TASK-200)
    await pool.query(
      "INSERT INTO research_board_tasks(id, project_id, title, status, task_key) VALUES ($1, $2, 'Task A', 'TO DO', 'TASK-100'), ($3, $4, 'Task B', 'TO DO', 'TASK-200')",
      [ids.taskA, ids.projA, ids.taskB, ids.projB]
    );

    // 1. Same physical GitHub repository registered on Research A and Research B
    await pool.query(
      `INSERT INTO research_repositories (id, project_id, provider, github_owner, github_repo, github_repository_id, default_branch, is_private, is_active)
       VALUES ($1, $2, 'github', 'org', 'shared-app', '90001', 'main', false, true),
              ($3, $4, 'github', 'org', 'shared-app', '90001', 'main', false, true)`,
      [ids.repoA, ids.projA, ids.repoB, ids.projB]
    );

    const webhookRouter = githubRouter.createRouter();
    const app = express();
    app.use(express.json({
      verify: (req, res, b) => {
        if (req.path === "/api/v1/integrations/github/webhook") req.rawBody = Buffer.from(b);
      }
    }));
    app.use((req, res, next) => {
      req.authUser = { id: ids.manager, role: "operator" };
      next();
    });
    app.use("/research", researchRouter);
    app.use("/api/v1/integrations", webhookRouter);
    app.use((err, req, res, next) => {
      res.status(err.statusCode || 500).json({ message: err.message, code: err.code });
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    async function api(method, path) {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-test-user-id": ids.manager, "x-test-role": "operator" }
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }

    async function webhook(delivery, payload, event = "push") {
      const raw = Buffer.from(JSON.stringify(payload));
      const sig = crypto.createHmac("sha256", "fanout-webhook-secret").update(raw).digest("hex");
      const r = await fetch(`${base}/api/v1/integrations/github/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": `sha256=${sig}`,
          "x-github-event": event,
          "x-github-delivery": delivery
        },
        body: raw
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }

    // 2. Keduanya active -> webhook menghasilkan activity pada kedua research
    const delivery1 = `${p}-del-1`;
    await t.test("2. keduanya active -> webhook menghasilkan activity pada kedua research", async () => {
      const payload = {
        repository: { id: 90001, full_name: "org/shared-app", owner: { login: "org" }, name: "shared-app" },
        ref: "refs/heads/main",
        sender: { login: "alice" },
        commits: [{ id: "sha-1", message: "implement TASK-100", url: "https://github/commit/1", timestamp: "2026-09-21T00:00:00Z" }]
      };
      const res = await webhook(delivery1, payload);
      assert.equal(res.status, 200);
      assert.equal(res.body.processed, true);
      assert.equal(res.body.activities, 2);
      assert.equal(res.body.matchedRepositories, 2);

      // Verify DB delivery table has 1 delivery row
      const deliveryRows = await pool.query("SELECT * FROM research_github_webhook_deliveries WHERE delivery_id = $1", [delivery1]);
      assert.equal(deliveryRows.rowCount, 1);
      assert.equal(deliveryRows.rows[0].status, "processed");

      // Verify junction table research_github_delivery_repositories has both repositories
      const deliveryRepoRows = await pool.query(
        "SELECT repository_id FROM research_github_delivery_repositories WHERE delivery_id = $1 ORDER BY repository_id ASC",
        [delivery1]
      );
      assert.equal(deliveryRepoRows.rowCount, 2);
      assert.deepEqual(deliveryRepoRows.rows.map(r => r.repository_id).sort(), [ids.repoA, ids.repoB].sort());

      // Verify research_github_activities has 2 rows
      const activities = (await pool.query(
        "SELECT * FROM research_github_activities WHERE delivery_id = $1 ORDER BY repository_id ASC",
        [delivery1]
      )).rows;
      assert.equal(activities.length, 2);

      const actA = activities.find(a => a.repository_id === ids.repoA);
      const actB = activities.find(a => a.repository_id === ids.repoB);
      assert.ok(actA);
      assert.ok(actB);

      // 6. task association tetap project-scoped: TASK-100 matched in Project A, not Project B
      assert.equal(actA.task_id, ids.taskA);
      assert.equal(actB.task_id, null);

      // Verify GET /research/:id/github-activity returns the activity for each project
      const listA = await api("GET", `/research/${ids.projA}/github-activity`);
      assert.equal(listA.status, 200);
      assert.equal(listA.body.length, 1);
      assert.equal(listA.body[0].task_id, ids.taskA);

      const listB = await api("GET", `/research/${ids.projB}/github-activity`);
      assert.equal(listB.status, 200);
      assert.equal(listB.body.length, 1);
      assert.equal(listB.body[0].task_id, null);
    });

    // 5. delivery retry tidak menggandakan activity pada A/B
    await t.test("5. delivery retry tidak menggandakan activity pada A/B", async () => {
      const payload = {
        repository: { id: 90001, full_name: "org/shared-app", owner: { login: "org" }, name: "shared-app" },
        ref: "refs/heads/main",
        sender: { login: "alice" },
        commits: [{ id: "sha-1", message: "implement TASK-100", url: "https://github/commit/1", timestamp: "2026-09-21T00:00:00Z" }]
      };
      const retryRes = await webhook(delivery1, payload);
      assert.equal(retryRes.status, 200);
      assert.equal(retryRes.body.ignored, true);
      assert.equal(retryRes.body.duplicate, true);

      // Verify no extra activities were inserted
      const count = await pool.query("SELECT COUNT(*)::int AS c FROM research_github_activities WHERE delivery_id = $1", [delivery1]);
      assert.equal(count.rows[0].c, 2);
    });

    // 6b. task association project-scoped in the opposite direction (TASK-200 belongs to Project B)
    await t.test("6b. task association matches task in Project B without leaking to Project A", async () => {
      const delivery2 = `${p}-del-2`;
      const payload = {
        repository: { id: 90001, full_name: "org/shared-app", owner: { login: "org" }, name: "shared-app" },
        ref: "refs/heads/main",
        sender: { login: "bob" },
        commits: [{ id: "sha-2", message: "implement TASK-200 for B", url: "https://github/commit/2", timestamp: "2026-09-21T01:00:00Z" }]
      };
      const res = await webhook(delivery2, payload);
      assert.equal(res.status, 200);
      assert.equal(res.body.activities, 2);

      const activities = (await pool.query(
        "SELECT * FROM research_github_activities WHERE delivery_id = $1 ORDER BY repository_id ASC",
        [delivery2]
      )).rows;
      assert.equal(activities.length, 2);

      const actA = activities.find(a => a.repository_id === ids.repoA);
      const actB = activities.find(a => a.repository_id === ids.repoB);
      assert.equal(actA.task_id, null); // TASK-200 does not exist in Project A
      assert.equal(actB.task_id, ids.taskB); // TASK-200 belongs to Project B
    });

    // 3. Research A removed, Research B active -> activity hanya masuk Research B
    await t.test("3. Research A removed, Research B active -> activity hanya masuk Research B", async () => {
      // Soft remove REPO-A
      await pool.query(
        "UPDATE research_repositories SET is_active = false, removed_at = NOW(), removed_by = $1 WHERE id = $2",
        [ids.manager, ids.repoA]
      );

      const delivery3 = `${p}-del-3`;
      const payload = {
        repository: { id: 90001, full_name: "org/shared-app", owner: { login: "org" }, name: "shared-app" },
        ref: "refs/heads/main",
        sender: { login: "charlie" },
        commits: [{ id: "sha-3", message: "fix: general patch", url: "https://github/commit/3", timestamp: "2026-09-21T02:00:00Z" }]
      };
      const res = await webhook(delivery3, payload);
      assert.equal(res.status, 200);
      assert.equal(res.body.activities, 1);
      assert.equal(res.body.matchedRepositories, 1);

      const activities = (await pool.query(
        "SELECT * FROM research_github_activities WHERE delivery_id = $1",
        [delivery3]
      )).rows;
      assert.equal(activities.length, 1);
      assert.equal(activities[0].repository_id, ids.repoB);

      // Check delivery junction table only has REPO-B
      const deliveryRepos = await pool.query(
        "SELECT repository_id FROM research_github_delivery_repositories WHERE delivery_id = $1",
        [delivery3]
      );
      assert.equal(deliveryRepos.rowCount, 1);
      assert.equal(deliveryRepos.rows[0].repository_id, ids.repoB);

      // Historical activities of Project A remain intact (from delivery 1 and 2)
      const listA = await api("GET", `/research/${ids.projA}/github-activity`);
      assert.equal(listA.body.length, 2);
    });

    // 4. Research A inactive, Research B active -> activity hanya masuk Research B
    await t.test("4. Research A inactive, Research B active -> activity hanya masuk Research B", async () => {
      // Clear removed_at on REPO-A but keep is_active = false
      await pool.query(
        "UPDATE research_repositories SET is_active = false, removed_at = NULL WHERE id = $1",
        [ids.repoA]
      );

      const delivery4 = `${p}-del-4`;
      const payload = {
        repository: { id: 90001, full_name: "org/shared-app", owner: { login: "org" }, name: "shared-app" },
        ref: "refs/heads/main",
        sender: { login: "david" },
        commits: [{ id: "sha-4", message: "fix: inactive test patch", url: "https://github/commit/4", timestamp: "2026-09-21T03:00:00Z" }]
      };
      const res = await webhook(delivery4, payload);
      assert.equal(res.status, 200);
      assert.equal(res.body.activities, 1);
      assert.equal(res.body.matchedRepositories, 1);

      const activities = (await pool.query(
        "SELECT * FROM research_github_activities WHERE delivery_id = $1",
        [delivery4]
      )).rows;
      assert.equal(activities.length, 1);
      assert.equal(activities[0].repository_id, ids.repoB);
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.query("DELETE FROM research_projects WHERE id = ANY($1::text[])", [[ids.projA, ids.projB]]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = $1", [ids.manager]).catch(() => {});
    await pool.end();
  }
});
