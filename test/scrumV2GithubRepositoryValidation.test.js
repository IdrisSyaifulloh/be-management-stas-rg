const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const http = require("node:http");
const express = require("express");
const { validateGitHubRepository, createGitHubAppJwt, isGitHubConfigured } = require("../utils/githubApp");

// ── Unit Tests for validateGitHubRepository ──

test("1. validation sukses: returns verified canonical metadata from GitHub", async () => {
  const kp = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const oldEnv = { id: process.env.GITHUB_APP_ID, key: process.env.GITHUB_APP_PRIVATE_KEY, secret: process.env.GITHUB_WEBHOOK_SECRET };
  process.env.GITHUB_APP_ID = "123";
  process.env.GITHUB_APP_PRIVATE_KEY = kp.privateKey.export({ type: "pkcs1", format: "pem" });
  process.env.GITHUB_WEBHOOK_SECRET = "secret";

  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const urlStr = String(url);
    if (urlStr.includes("/repos/HMNTR/STAS-RG_MS_FE/installation")) {
      return { ok: true, status: 200, json: async () => ({ id: 161475442 }) };
    }
    if (urlStr.includes("/access_tokens")) {
      return { ok: true, status: 200, json: async () => ({ token: "mock-token-abc" }) };
    }
    if (urlStr.includes("/repos/HMNTR/STAS-RG_MS_FE")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 1191366862,
          name: "STAS-RG_MS_FE",
          full_name: "HMNTR/STAS-RG_MS_FE",
          default_branch: "main",
          private: false,
          html_url: "https://github.com/HMNTR/STAS-RG_MS_FE",
          owner: { login: "HMNTR" }
        })
      };
    }
    throw new Error(`Unexpected fetch call: ${urlStr}`);
  };

  try {
    const result = await validateGitHubRepository({
      owner: "HMNTR",
      repo: "STAS-RG_MS_FE",
      githubInstallationId: "161475442"
    });

    assert.equal(result.owner, "HMNTR");
    assert.equal(result.repo, "STAS-RG_MS_FE");
    assert.equal(result.fullName, "HMNTR/STAS-RG_MS_FE");
    assert.equal(result.githubRepositoryId, "1191366862");
    assert.equal(result.githubInstallationId, "161475442");
    assert.equal(result.defaultBranch, "main");
    assert.equal(result.isPrivate, false);
    assert.equal(result.htmlUrl, "https://github.com/HMNTR/STAS-RG_MS_FE");
  } finally {
    global.fetch = originalFetch;
    if (oldEnv.id === undefined) delete process.env.GITHUB_APP_ID; else process.env.GITHUB_APP_ID = oldEnv.id;
    if (oldEnv.key === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY; else process.env.GITHUB_APP_PRIVATE_KEY = oldEnv.key;
    if (oldEnv.secret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET; else process.env.GITHUB_WEBHOOK_SECRET = oldEnv.secret;
  }
});

test("2. repository tidak accessible: returns 404 with SCRUM_GITHUB_REPOSITORY_NOT_ACCESSIBLE", async () => {
  const kp = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const oldEnv = { id: process.env.GITHUB_APP_ID, key: process.env.GITHUB_APP_PRIVATE_KEY, secret: process.env.GITHUB_WEBHOOK_SECRET };
  process.env.GITHUB_APP_ID = "123";
  process.env.GITHUB_APP_PRIVATE_KEY = kp.privateKey.export({ type: "pkcs1", format: "pem" });
  process.env.GITHUB_WEBHOOK_SECRET = "secret";

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("/installation")) {
      return { ok: false, status: 404, json: async () => ({ message: "Not Found" }) };
    }
    throw new Error(`Unexpected fetch call: ${urlStr}`);
  };

  try {
    await assert.rejects(
      async () => {
        await validateGitHubRepository({ owner: "secret-org", repo: "private-repo" });
      },
      (err) => {
        assert.equal(err.statusCode, 404);
        assert.equal(err.code, "SCRUM_GITHUB_REPOSITORY_NOT_ACCESSIBLE");
        assert.match(err.message, /Repository tidak ditemukan atau GitHub App STAS-RG Scrum belum memiliki akses/);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
    if (oldEnv.id === undefined) delete process.env.GITHUB_APP_ID; else process.env.GITHUB_APP_ID = oldEnv.id;
    if (oldEnv.key === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY; else process.env.GITHUB_APP_PRIVATE_KEY = oldEnv.key;
    if (oldEnv.secret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET; else process.env.GITHUB_WEBHOOK_SECRET = oldEnv.secret;
  }
});

test("3. installation ID mismatch: returns 409 with SCRUM_GITHUB_INSTALLATION_MISMATCH", async () => {
  const kp = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const oldEnv = { id: process.env.GITHUB_APP_ID, key: process.env.GITHUB_APP_PRIVATE_KEY, secret: process.env.GITHUB_WEBHOOK_SECRET };
  process.env.GITHUB_APP_ID = "123";
  process.env.GITHUB_APP_PRIVATE_KEY = kp.privateKey.export({ type: "pkcs1", format: "pem" });
  process.env.GITHUB_WEBHOOK_SECRET = "secret";

  const originalFetch = global.fetch;
  global.fetch = async () => {
    return { ok: true, status: 200, json: async () => ({ id: 161475442 }) };
  };

  try {
    await assert.rejects(
      async () => {
        await validateGitHubRepository({
          owner: "HMNTR",
          repo: "STAS-RG_MS_FE",
          githubInstallationId: "999999999"
        });
      },
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.code, "SCRUM_GITHUB_INSTALLATION_MISMATCH");
        assert.match(err.message, /Installation ID tidak sesuai/);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
    if (oldEnv.id === undefined) delete process.env.GITHUB_APP_ID; else process.env.GITHUB_APP_ID = oldEnv.id;
    if (oldEnv.key === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY; else process.env.GITHUB_APP_PRIVATE_KEY = oldEnv.key;
    if (oldEnv.secret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET; else process.env.GITHUB_WEBHOOK_SECRET = oldEnv.secret;
  }
});

test("GitHub unconfigured error: returns 503 with SCRUM_GITHUB_NOT_CONFIGURED", async () => {
  const oldEnv = { id: process.env.GITHUB_APP_ID, key: process.env.GITHUB_APP_PRIVATE_KEY, secret: process.env.GITHUB_WEBHOOK_SECRET };
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  delete process.env.GITHUB_WEBHOOK_SECRET;

  try {
    await assert.rejects(
      async () => {
        await validateGitHubRepository({ owner: "HMNTR", repo: "STAS-RG_MS_FE" });
      },
      (err) => {
        assert.equal(err.statusCode, 503);
        assert.equal(err.code, "SCRUM_GITHUB_NOT_CONFIGURED");
        return true;
      }
    );
  } finally {
    if (oldEnv.id !== undefined) process.env.GITHUB_APP_ID = oldEnv.id;
    if (oldEnv.key !== undefined) process.env.GITHUB_APP_PRIVATE_KEY = oldEnv.key;
    if (oldEnv.secret !== undefined) process.env.GITHUB_WEBHOOK_SECRET = oldEnv.secret;
  }
});

// ── Integration Tests against database ──

const testDbUrl = process.env.TEST_DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5433/stasrg_test_suite";
const runDbSuite = Boolean(process.env.RUN_SCRUM_V2_GITHUB_INTEGRATION_TESTS === "true" || process.env.TEST_DATABASE_URL || process.env.RUN_ALL_INTEGRATION_TESTS === "true");

test("Integration Suite: Cases 4 through 18", { skip: !runDbSuite && "Set TEST_DATABASE_URL to run DB integration suite." }, async (t) => {
  process.env.DATABASE_URL = testDbUrl;
  process.env.NODE_ENV = "test";
  const { pool } = require("../db/pool");
  const { prepareFreshScrumV2Database } = require("./helpers/prepareScrumV2Database");
  const { ensureResearchBoardTables } = require("../utils/researchBoardStore");
  const researchRouter = require("../routes/api/research");
  const githubRouter = require("../routes/api/githubIntegration");

  const p = `TEST-REPO-VAL-${Date.now()}`;
  const ids = {
    projectA: `${p}-PA`,
    projectB: `${p}-PB`,
    manager: `${p}-MGR`,
    student: `${p}-STU`,
    taskA: `${p}-TA`
  };

  const kp = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const oldEnv = { id: process.env.GITHUB_APP_ID, key: process.env.GITHUB_APP_PRIVATE_KEY, secret: process.env.GITHUB_WEBHOOK_SECRET };
  process.env.GITHUB_APP_ID = "123";
  process.env.GITHUB_APP_PRIVATE_KEY = kp.privateKey.export({ type: "pkcs1", format: "pem" });
  process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";

  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const urlStr = String(url);
    if (urlStr.includes("/repos/HMNTR/STAS-RG_MS_FE/installation")) {
      return { ok: true, status: 200, json: async () => ({ id: 161475442 }) };
    }
    if (urlStr.includes("/access_tokens")) {
      return { ok: true, status: 200, json: async () => ({ token: "mock-token-abc" }) };
    }
    if (urlStr.includes("/repos/HMNTR/STAS-RG_MS_FE")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 1191366862,
          name: "STAS-RG_MS_FE",
          full_name: "HMNTR/STAS-RG_MS_FE",
          default_branch: "main",
          private: false,
          html_url: "https://github.com/HMNTR/STAS-RG_MS_FE",
          owner: { login: "HMNTR" }
        })
      };
    }
    return originalFetch(url, opts);
  };

  let server;
  let base;

  try {
    await prepareFreshScrumV2Database(pool, testDbUrl);
    await ensureResearchBoardTables();

    // Seed users and projects
    await pool.query(
      "INSERT INTO users(id, name, initials, role, email, is_active) VALUES ($1, 'Manager User', 'MU', 'operator', $3, true), ($2, 'Student User', 'SU', 'mahasiswa', $4, true)",
      [ids.manager, ids.student, `${ids.manager}@test.local`, `${ids.student}@test.local`]
    );
    await pool.query(
      "INSERT INTO research_projects(id, title, status) VALUES ($1, 'Research Project A', 'Aktif'), ($2, 'Research Project B', 'Aktif')",
      [ids.projectA, ids.projectB]
    );
    await pool.query(
      "INSERT INTO research_memberships(project_id, user_id, member_type, peran, status) VALUES ($1, $2, 'Mahasiswa', 'Anggota', 'Aktif'), ($3, $2, 'Mahasiswa', 'Anggota', 'Aktif')",
      [ids.projectA, ids.student, ids.projectB]
    );
    await pool.query(
      "INSERT INTO research_board_tasks(id, project_id, title, status) VALUES ($1, $2, 'Feature X', 'TO DO')",
      [ids.taskA, ids.projectA]
    );

    const webhookRouter = githubRouter.createRouter();
    const app = express();
    app.use(express.json({
      verify: (req, res, b) => {
        if (req.path === "/api/v1/integrations/github/webhook") req.rawBody = Buffer.from(b);
      }
    }));
    app.use((req, res, next) => {
      req.authUser = {
        id: req.headers["x-test-user-id"] || ids.manager,
        role: req.headers["x-test-role"] || "operator"
      };
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

    const headers = (role = "operator", id = ids.manager) => ({
      "content-type": "application/json",
      "x-test-role": role,
      "x-test-user-id": id
    });

    async function api(method, path, body, h = headers()) {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }

    async function webhook(delivery, payload, event = "push") {
      const raw = Buffer.from(JSON.stringify(payload));
      const sig = crypto.createHmac("sha256", "test-webhook-secret").update(raw).digest("hex");
      return api("POST", "/api/v1/integrations/github/webhook", payload, {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${sig}`,
        "x-github-event": event,
        "x-github-delivery": delivery
      });
    }

    // 17. User non-manager tidak bisa validate/create/remove
    await t.test("17. user non-manager tidak bisa validate/create/remove", async () => {
      const valRes = await api("POST", `/research/${ids.projectA}/repositories/validate`, { owner: "HMNTR", repo: "STAS-RG_MS_FE" }, headers("mahasiswa", ids.student));
      assert.equal(valRes.status, 403);
      const createRes = await api("POST", `/research/${ids.projectA}/repositories`, { owner: "HMNTR", repo: "STAS-RG_MS_FE" }, headers("mahasiswa", ids.student));
      assert.equal(createRes.status, 403);
      const delRes = await api("DELETE", `/research/${ids.projectA}/repositories/dummy-repo`, undefined, headers("mahasiswa", ids.student));
      assert.equal(delRes.status, 403);
    });

    // Validate endpoint before adding
    await t.test("Validate endpoint returns repository info, alreadyRegistered: false, canRestore: false", async () => {
      const res = await api("POST", `/research/${ids.projectA}/repositories/validate`, {
        owner: "HMNTR",
        repo: "STAS-RG_MS_FE",
        githubInstallationId: "161475442"
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.valid, true);
      assert.equal(res.body.alreadyRegistered, false);
      assert.equal(res.body.canRestore, false);
      assert.equal(res.body.repository.fullName, "HMNTR/STAS-RG_MS_FE");
    });

    // 4. Create menggunakan metadata GitHub, bukan metadata client
    let createdRepoId;
    await t.test("4. create menggunakan metadata GitHub, bukan metadata client", async () => {
      const res = await api("POST", `/research/${ids.projectA}/repositories`, {
        owner: "HMNTR",
        repo: "STAS-RG_MS_FE",
        githubRepositoryId: "999999999", // spoofed client metadata
        defaultBranch: "client-branch",  // spoofed client metadata
        isPrivate: true                  // spoofed client metadata
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.repository.githubRepositoryId, "1191366862"); // enforced from GitHub
      assert.equal(res.body.repository.defaultBranch, "main");           // enforced from GitHub
      assert.equal(res.body.repository.isPrivate, false);                // enforced from GitHub
      createdRepoId = res.body.repository.id;
    });

    // 5. Repository duplicate aktif -> 409
    await t.test("5. repository duplicate aktif -> 409", async () => {
      const res = await api("POST", `/research/${ids.projectA}/repositories`, {
        owner: "HMNTR",
        repo: "STAS-RG_MS_FE"
      });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, "SCRUM_REPOSITORY_EXISTS");

      // Validate now shows alreadyRegistered: true
      const valRes = await api("POST", `/research/${ids.projectA}/repositories/validate`, {
        owner: "HMNTR",
        repo: "STAS-RG_MS_FE"
      });
      assert.equal(valRes.status, 200);
      assert.equal(valRes.body.alreadyRegistered, true);
      assert.equal(valRes.body.canRestore, false);
    });

    // Setup task link & historical activity for verification
    const linkRes = await api("POST", `/research/${ids.projectA}/board/tasks/${ids.taskA}/repositories`, {
      repositoryId: createdRepoId,
      branchName: "feature/login"
    });
    assert.equal(linkRes.status, 201);

    const deliveryId = `${p}-DELIVERY-HISTORICAL`;
    await pool.query(
      "INSERT INTO research_github_webhook_deliveries(delivery_id, event_name, repository_id, status, processed_at) VALUES ($1, 'push', $2, 'processed', NOW())",
      [deliveryId, createdRepoId]
    );
    await pool.query(
      "INSERT INTO research_github_activities(id, repository_id, task_id, delivery_id, activity_type, commit_message, occurred_at) VALUES ($1, $2, $3, $4, 'push', 'initial commit', NOW())",
      [`${p}-ACT-1`, createdRepoId, ids.taskA, deliveryId]
    );

    // 7. remove repository -> removed_at terisi & 8. is_active FALSE
    await t.test("7 & 8. remove repository sets removed_at and is_active FALSE", async () => {
      const delRes = await api("DELETE", `/research/${ids.projectA}/repositories/${createdRepoId}`);
      assert.equal(delRes.status, 200);
      assert.equal(delRes.body.repository.isActive, false);
      assert.ok(delRes.body.repository.removedAt);

      const dbRow = (await pool.query("SELECT * FROM research_repositories WHERE id = $1", [createdRepoId])).rows[0];
      assert.equal(dbRow.is_active, false);
      assert.ok(dbRow.removed_at);
      assert.equal(dbRow.removed_by, ids.manager);
    });

    // 9. Historical activity tidak terhapus
    await t.test("9. historical activity tidak terhapus", async () => {
      const count = await pool.query("SELECT COUNT(*)::int AS c FROM research_github_activities WHERE repository_id = $1", [createdRepoId]);
      assert.equal(count.rows[0].c, 1);

      const actRes = await api("GET", `/research/${ids.projectA}/github-activity`);
      assert.equal(actRes.status, 200);
      assert.ok(actRes.body.some((a) => a.id === `${p}-ACT-1`));
    });

    // 10. Task repository historical link tidak terhapus
    await t.test("10. task repository historical link tidak terhapus", async () => {
      const count = await pool.query("SELECT COUNT(*)::int AS c FROM research_task_repository_links WHERE repository_id = $1", [createdRepoId]);
      assert.equal(count.rows[0].c, 1);
    });

    // 11. GET repositories tidak menampilkan removed repo
    await t.test("11. GET repositories tidak menampilkan removed repo", async () => {
      const listRes = await api("GET", `/research/${ids.projectA}/repositories`);
      assert.equal(listRes.status, 200);
      assert.equal(listRes.body.repositories.length, 0);
    });

    // 12. PATCH removed repo -> 404
    await t.test("12. PATCH removed repo -> 404", async () => {
      const patchRes = await api("PATCH", `/research/${ids.projectA}/repositories/${createdRepoId}`, {
        defaultBranch: "develop"
      });
      assert.equal(patchRes.status, 404);
    });

    // 13. Task tidak dapat link ke removed repo
    await t.test("13. task tidak dapat link ke removed repo", async () => {
      const linkRes2 = await api("POST", `/research/${ids.projectA}/board/tasks/${ids.taskA}/repositories`, {
        repositoryId: createdRepoId
      });
      assert.equal(linkRes2.status, 400);
    });

    // 14. Webhook removed repo -> ignored
    await t.test("14. webhook removed repo -> ignored", async () => {
      const whRes = await webhook(`${p}-del-removed`, {
        repository: { id: 1191366862, full_name: "HMNTR/STAS-RG_MS_FE", owner: { login: "HMNTR" }, name: "STAS-RG_MS_FE" },
        commits: [{ id: "abc", message: "TASK-1" }]
      });
      assert.equal(whRes.status, 200);
      assert.equal(whRes.body.ignored, true);
      assert.equal(whRes.body.reason, "unknown_repository");
    });

    // 15. Webhook inactive repo -> ignored
    await t.test("15. webhook inactive repo -> ignored", async () => {
      const inactiveProjId = `${p}-PINACTIVE`;
      await pool.query("INSERT INTO research_projects(id, title, status) VALUES ($1, 'Inactive Test', 'Aktif')", [inactiveProjId]);
      const inactiveId = `${p}-INACTIVE-REPO`;
      await pool.query(
        "INSERT INTO research_repositories(id, project_id, provider, github_owner, github_repo, github_repository_id, is_active) VALUES ($1, $2, 'github', 'inactive-owner', 'inactive-repo', '99999', false)",
        [inactiveId, inactiveProjId]
      );
      const whRes = await webhook(`${p}-del-inactive`, {
        repository: { id: 99999, full_name: "inactive-owner/inactive-repo", owner: { login: "inactive-owner" }, name: "inactive-repo" },
        commits: [{ id: "abc", message: "TASK-1" }]
      });
      assert.equal(whRes.status, 200);
      assert.equal(whRes.body.ignored, true);
      assert.equal(whRes.body.reason, "unknown_repository");
    });

    // 16. Repo yang sama di project lain tidak terpengaruh
    await t.test("16. repo yang sama di project lain tidak terpengaruh", async () => {
      const createResB = await api("POST", `/research/${ids.projectB}/repositories`, {
        owner: "HMNTR",
        repo: "STAS-RG_MS_FE"
      });
      assert.equal(createResB.status, 201);
      assert.equal(createResB.body.repository.githubRepo, "STAS-RG_MS_FE");

      const listB = await api("GET", `/research/${ids.projectB}/repositories`);
      assert.equal(listB.body.repositories.length, 1);

      const listA = await api("GET", `/research/${ids.projectA}/repositories`);
      assert.equal(listA.body.repositories.length, 0); // Still soft-removed in Project A
    });

    // 18. Double remove aman -> 404 / deterministic response
    await t.test("18. double remove aman -> 404 / deterministic response", async () => {
      const delAgain = await api("DELETE", `/research/${ids.projectA}/repositories/${createdRepoId}`);
      assert.equal(delAgain.status, 404);
      assert.equal(delAgain.body.code, "SCRUM_REPOSITORY_NOT_FOUND");
    });

    // 6. Repository removed -> create melakukan restore
    await t.test("6. repository removed -> create melakukan restore", async () => {
      // Validate shows canRestore: true
      const valRes = await api("POST", `/research/${ids.projectA}/repositories/validate`, {
        owner: "HMNTR",
        repo: "STAS-RG_MS_FE"
      });
      assert.equal(valRes.status, 200);
      assert.equal(valRes.body.alreadyRegistered, false);
      assert.equal(valRes.body.canRestore, true);

      // Create triggers restore
      const restoreRes = await api("POST", `/research/${ids.projectA}/repositories`, {
        owner: "HMNTR",
        repo: "STAS-RG_MS_FE"
      });
      assert.equal(restoreRes.status, 200);
      assert.equal(restoreRes.body.restored, true);
      assert.equal(restoreRes.body.repository.id, createdRepoId); // ID internal tetap sama
      assert.equal(restoreRes.body.repository.isActive, true);
      assert.equal(restoreRes.body.repository.removedAt, null);

      // Verify active list in Project A
      const listA = await api("GET", `/research/${ids.projectA}/repositories`);
      assert.equal(listA.body.repositories.length, 1);
      assert.equal(listA.body.repositories[0].id, createdRepoId);
    });
  } finally {
    global.fetch = originalFetch;
    if (oldEnv.id === undefined) delete process.env.GITHUB_APP_ID; else process.env.GITHUB_APP_ID = oldEnv.id;
    if (oldEnv.key === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY; else process.env.GITHUB_APP_PRIVATE_KEY = oldEnv.key;
    if (oldEnv.secret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET; else process.env.GITHUB_WEBHOOK_SECRET = oldEnv.secret;
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.query("DELETE FROM research_projects WHERE id = ANY($1::text[])", [[ids.projectA, ids.projectB]]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = ANY($1::text[])", [[ids.manager, ids.student]]).catch(() => {});
    await pool.end();
  }
});
