const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("node:fs");
const path = require("node:path");
const { extractTaskKeys } = require("../utils/githubTaskReference");
const { isGitHubConfigured, createGitHubAppJwt, createInstallationAccessToken } = require("../utils/githubApp");

test("GitHub task key parser normalizes and deduplicates references", () => {
  assert.deepEqual(extractTaskKeys("task-12 TASK-12 branch-99"), ["TASK-12"]);
  assert.deepEqual(extractTaskKeys("TASK-1x"), []);
  assert.deepEqual(extractTaskKeys("123 456"), []);
});

test("GitHub App stays disabled without configuration", () => {
  const old = { id: process.env.GITHUB_APP_ID, key: process.env.GITHUB_APP_PRIVATE_KEY, secret: process.env.GITHUB_WEBHOOK_SECRET };
  delete process.env.GITHUB_APP_ID; delete process.env.GITHUB_APP_PRIVATE_KEY; delete process.env.GITHUB_WEBHOOK_SECRET;
  assert.equal(isGitHubConfigured(), false);
  assert.equal(createGitHubAppJwt(), null);
  if (old.id !== undefined) process.env.GITHUB_APP_ID = old.id;
  if (old.key !== undefined) process.env.GITHUB_APP_PRIVATE_KEY = old.key;
  if (old.secret !== undefined) process.env.GITHUB_WEBHOOK_SECRET = old.secret;
});

test("raw webhook signature changes when bytes change", () => {
  const secret = "scrum-v2-webhook-secret";
  const raw = Buffer.from('{"a":1}');
  const signature = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  assert.equal(signature, crypto.createHmac("sha256", secret).update(raw).digest("hex"));
  assert.notEqual(signature, crypto.createHmac("sha256", secret).update(Buffer.from('{ "a": 1 }')).digest("hex"));
});

test("application wiring exposes only the canonical v1 webhook path", () => {
  const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const apiIndexSource = fs.readFileSync(path.join(__dirname, "..", "routes", "api", "index.js"), "utf8");
  assert.match(appSource, /app\.use\("\/api\/v1\/integrations", githubIntegrationRouter\)/);
  assert.doesNotMatch(appSource, /app\.use\("\/api\/integrations", githubIntegrationRouter\)/);
  assert.doesNotMatch(apiIndexSource, /githubIntegrationRouter/);
});

const enabled = process.env.RUN_SCRUM_V2_GITHUB_INTEGRATION_TESTS === "true" && Boolean(process.env.TEST_DATABASE_URL);
if (!enabled) {
  test("GitHub integration database suite", { skip: "Set RUN_SCRUM_V2_GITHUB_INTEGRATION_TESTS=true and TEST_DATABASE_URL." }, () => {});
} else {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.NODE_ENV = "test";
  const http = require("node:http");
  const express = require("express");
  const researchRouter = require("../routes/api/research");
  const githubRouter = require("../routes/api/githubIntegration");
  const { pool } = require("../db/pool");
  const { ensureResearchBoardTables } = require("../utils/researchBoardStore");
  const { prepareFreshScrumV2Database } = require("./helpers/prepareScrumV2Database");
  const p = `SCRUM-V2-GH-${process.pid}-${Date.now()}`;
  const ids = { project: `${p}-P`, other: `${p}-OTHER`, manager: `${p}-M`, lecturer: `${p}-L`, student: `${p}-S`, task: `${p}-TASK`, repo: `${p}-REPO`, otherRepo: `${p}-OTHER-REPO` };
  let server; let base; let failOnceDelivery = null;
  const headers = (role = "operator", id = ids.manager) => ({ "content-type": "application/json", "x-test-role": role, "x-test-user-id": id });
  async function api(method, path, body, h = headers()) { const r = await fetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }
  async function webhook(delivery, payload, event = "push", raw = Buffer.from(JSON.stringify(payload)), secret = "gh-test-secret") { const sig = crypto.createHmac("sha256", secret).update(raw).digest("hex"); return api("POST", "/api/v1/integrations/github/webhook", payload, { "content-type": "application/json", "x-hub-signature-256": `sha256=${sig}`, "x-github-event": event, "x-github-delivery": delivery }); }
  async function rawWebhookPath(path, delivery, payload) {
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = crypto.createHmac("sha256", "gh-test-secret").update(raw).digest("hex");
    const url = new URL(base);
    return new Promise((resolve, reject) => {
      const request = http.request({
        hostname: url.hostname,
        port: url.port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": raw.length,
          "x-hub-signature-256": `sha256=${signature}`,
          "x-github-event": "push",
          "x-github-delivery": delivery
        }
      }, (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode }));
      });
      request.on("error", reject);
      request.end(raw);
    });
  }
  test("GitHub integration against disposable DB", async (t) => {
    try {
      process.env.GITHUB_WEBHOOK_SECRET = "gh-test-secret";
      await prepareFreshScrumV2Database(pool, process.env.TEST_DATABASE_URL);
      await ensureResearchBoardTables();
      await pool.query("DELETE FROM research_projects WHERE id = ANY($1::text[])", [[ids.project, ids.other]]);
      await pool.query("DELETE FROM users WHERE id = ANY($1::text[])", [[ids.manager, ids.lecturer, ids.student]]);
      await pool.query("INSERT INTO users(id,name,initials,role,email,is_active) VALUES($1,'GH Manager','GM','operator',$4,true),($2,'GH Lecturer','GL','dosen',$5,true),($3,'GH Student','GS','mahasiswa',$6,true)", [ids.manager,ids.lecturer,ids.student,`${ids.manager}@test.local`,`${ids.lecturer}@test.local`,`${ids.student}@test.local`]);
      await pool.query("INSERT INTO research_projects(id,title,status) VALUES($1,'GH Project','Aktif'),($2,'GH Other','Aktif')", [ids.project,ids.other]);
      await pool.query("INSERT INTO research_memberships(project_id,user_id,member_type,peran,status) VALUES($1,$2,'Mahasiswa','Anggota','Aktif'),($1,$3,'Dosen','Anggota','Aktif')", [ids.project,ids.student,ids.lecturer]);
      await pool.query("INSERT INTO research_divisions(id,project_id,name) VALUES($1,$2,'Web')", [`${p}-DIV`,ids.project]);
      await pool.query("INSERT INTO research_board_tasks(id,project_id,title,status) VALUES($1,$2,'Authentication','TO DO')", [ids.task,ids.project]);
      await pool.query("INSERT INTO research_sprints(id,project_id,name,status) VALUES($1,$2,'Source','closed'),($3,$2,'Target','planning')", [`${p}-S1`,ids.project,`${p}-S2`]);
      await pool.query("UPDATE research_board_tasks SET sprint_id=$2 WHERE id=$1", [ids.task,`${p}-S1`]);
      await pool.query("INSERT INTO research_sprint_task_assignments(id,sprint_id,task_id,status_at_assignment) VALUES($1,$2,$3,'TO DO')", [`${p}-LEDGER`,`${p}-S1`,ids.task]);
      await pool.query("INSERT INTO research_sprint_summaries(id,sprint_id,summary) VALUES($1,$2,'Existing summary')", [`${p}-SUM`,`${p}-S1`]);
      await pool.query("INSERT INTO research_sprint_member_evaluations(id,sprint_id,evaluated_user_id,task_completion,quality,timeliness,collaboration,initiative,overall_score,notes,created_by) VALUES($1,$2,$3,8,7,9,8,8,8,'unchanged',$4)", [`${p}-EVAL`,`${p}-S1`,ids.student,ids.manager]);
      const webhookRouter = githubRouter.createRouter({ afterClaim: async ({ delivery }) => { if (delivery === failOnceDelivery) { failOnceDelivery = null; throw new Error("Injected webhook persistence failure"); } } });
      const app = express(); app.use(express.json({ verify: (req,res,b) => { if (req.path === "/api/v1/integrations/github/webhook") req.rawBody = Buffer.from(b); } })); app.use((req,res,next)=>{req.authUser={id:req.headers["x-test-user-id"]||ids.manager,role:req.headers["x-test-role"]||"operator"};next();}); app.use("/research",researchRouter); app.use("/api/v1/integrations",webhookRouter); app.use((req,res)=>res.status(404).json({message:"Route tidak ditemukan"})); app.use((e,req,res,next)=>res.status(e.statusCode||500).json({message:e.message,code:e.code})); server=http.createServer(app); await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve)); base=`http://127.0.0.1:${server.address().port}`;
      await t.test("only the canonical router exposes a GitHub webhook", async () => {
        const researchWebhookRoutes = researchRouter.stack.filter((layer) => String(layer.route?.path || "").includes("github/webhook"));
        const canonicalWebhookRoutes = webhookRouter.stack.filter((layer) => layer.route?.path === "/github/webhook");
        assert.equal(researchWebhookRoutes.length, 0);
        assert.equal(canonicalWebhookRoutes.length, 1);
        const delivery = `${p}-stale-path`;
        const stale = await rawWebhookPath("/api/integrations/github/webhook", delivery, {
          repository: { id: 42, full_name: "acme/demo", owner: { login: "acme" }, name: "demo" },
          ref: "refs/heads/main",
          commits: [{ id: "stale", message: "TASK-1" }]
        });
        assert.equal(stale.status, 404);
        assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM research_github_webhook_deliveries WHERE delivery_id=$1", [delivery])).rows[0].count, 0);
        const canonicalDelivery = `${p}-canonical-path`;
        const canonical = await rawWebhookPath("/api/v1/integrations/github/webhook", canonicalDelivery, {
          repository: { full_name: "none/nope" }, commits: []
        });
        assert.equal(canonical.status, 200);
        assert.equal((await pool.query("SELECT status FROM research_github_webhook_deliveries WHERE delivery_id=$1", [canonicalDelivery])).rows[0].status, "ignored");
      });
      await t.test("registry, task key, links, and authorization", async () => {
        const created=await api("POST",`/research/${ids.project}/repositories`,{id:ids.repo,owner:"acme",repo:"demo",githubRepositoryId:"42"}); assert.equal(created.status,201); assert.equal(created.body.repository.githubOwner,"acme");
        const listed=await api("GET",`/research/${ids.project}/repositories`); assert.equal(listed.status,200); assert.equal(listed.body.repositories.length,1); assert.equal(Object.prototype.hasOwnProperty.call(listed.body,"privateKey"),false);
        const duplicate=await api("POST",`/research/${ids.project}/repositories`,{owner:"acme",repo:"demo"}); assert.equal(duplicate.status,409);
        const lecturer=await api("GET",`/research/${ids.project}/repositories`,undefined,headers("dosen",ids.lecturer)); assert.equal(lecturer.status,200);
        const lecturerCrossProject=await api("GET",`/research/${ids.other}/repositories`,undefined,headers("dosen",ids.lecturer)); assert.equal(lecturerCrossProject.status,403);
        const student=await api("POST",`/research/${ids.project}/repositories`,{owner:"x",repo:"y"},headers("mahasiswa",ids.student)); assert.equal(student.status,403);
        const task=await api("GET",`/research/${ids.project}/board/tasks/${ids.task}`); assert.match(task.body.taskKey,/^TASK-[0-9]+$/); const immutable=await api("PATCH",`/research/${ids.project}/board/tasks/${ids.task}`,{task_key:"TASK-999"}); assert.equal(immutable.status,409); assert.equal(immutable.body.code,"SCRUM_SPRINT_READ_ONLY"); assert.equal((await api("GET",`/research/${ids.project}/board/tasks/${ids.task}`)).body.taskKey,task.body.taskKey);
        const link=await api("POST",`/research/${ids.project}/board/tasks/${ids.task}/repositories`,{repositoryId:ids.repo,branchName:"feature/TASK-1-login"}); assert.equal(link.status,201); const dupLink=await api("POST",`/research/${ids.project}/board/tasks/${ids.task}/repositories`,{repositoryId:ids.repo}); assert.equal(dupLink.status,409); await api("DELETE",`/research/${ids.project}/board/tasks/${ids.task}/repositories/${ids.repo}`); assert.equal((await api("GET",`/research/${ids.project}/board/tasks/${ids.task}/repositories`)).body.length,0);
        assert.equal((await api("POST",`/research/${ids.other}/repositories`,{id:ids.otherRepo,owner:"acme",repo:"other"})).status,201);
        const crossProjectLink = await api("POST",`/research/${ids.project}/board/tasks/${ids.task}/repositories`,{repositoryId:ids.otherRepo});
        assert.equal(crossProjectLink.status,400);
        assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM research_task_repository_links WHERE task_id=$1 AND repository_id=$2",[ids.task,ids.otherRepo])).rows[0].count,0);
        assert.equal((await api("PATCH",`/research/${ids.project}/repositories/${ids.otherRepo}`,{defaultBranch:"develop"})).status,404);
        const isolatedDelivery = `${p}-OTHER-PROJECT-ACTIVITY`;
        await pool.query("INSERT INTO research_github_webhook_deliveries(delivery_id,event_name,repository_id,status,processed_at) VALUES($1,'push',$2,'processed',NOW())",[isolatedDelivery,ids.otherRepo]);
        await pool.query("INSERT INTO research_github_activities(id,repository_id,delivery_id,activity_type) VALUES($1,$2,$3,'push')",[`${p}-OTHER-ACTIVITY`,ids.otherRepo,isolatedDelivery]);
        assert.equal((await api("GET",`/research/${ids.project}/github-activity`)).body.some((row)=>row.delivery_id===isolatedDelivery),false);
        assert.deepEqual((await api("GET",`/research/${ids.project}/board/tasks/${ids.task}/github-activity`)).body,[]);
      });
      await t.test("JWT and mocked installation token", async () => { const kp=crypto.generateKeyPairSync("rsa",{modulusLength:2048}); const old={id:process.env.GITHUB_APP_ID,key:process.env.GITHUB_APP_PRIVATE_KEY}; process.env.GITHUB_APP_ID="123";process.env.GITHUB_APP_PRIVATE_KEY=kp.privateKey.export({type:"pkcs1",format:"pem"}); const token=createGitHubAppJwt(); assert.equal(token.split(".").length,3); assert.equal(crypto.createVerify("RSA-SHA256").update(token.split(".").slice(0,2).join(".")).verify(kp.publicKey,token.split(".")[2],"base64url"),true); const oldFetch=global.fetch; global.fetch=async(url,opt)=>{assert.equal(url,"https://api.github.com/app/installations/77/access_tokens");assert.equal(opt.method,"POST");return {ok:true,json:async()=>({token:"short-lived"})};}; assert.equal((await createInstallationAccessToken("77")).token,"short-lived");global.fetch=oldFetch;if(old.id===undefined)delete process.env.GITHUB_APP_ID;else process.env.GITHUB_APP_ID=old.id;if(old.key===undefined)delete process.env.GITHUB_APP_PRIVATE_KEY;else process.env.GITHUB_APP_PRIVATE_KEY=old.key; });
      await t.test("HMAC, unknown repo, push/PR ingestion, association, suggestions, and no status mutation", async () => {
        const bad=await api("POST","/api/v1/integrations/github/webhook",{repository:{full_name:"none/nope"}},{"content-type":"application/json","x-github-event":"push","x-github-delivery":"bad"}); assert.equal(bad.status,401);
        const unknown=await webhook(`${p}-unknown`,{repository:{full_name:"none/nope"},commits:[]}); assert.equal(unknown.status,200); assert.equal(unknown.body.ignored,true);
        const payload={repository:{id:42,full_name:"acme/demo",owner:{login:"acme"},name:"demo"},ref:"refs/heads/feature/TASK-999",sender:{login:"dev"},commits:[{id:"abc",message:`fix ${"TASK-"+"1"}`,url:"https://github/commit/abc",timestamp:"2026-09-11T00:00:00Z"}]}; const push=await webhook(`${p}-push`,payload); assert.equal(push.status,200); const stored=await pool.query("SELECT * FROM research_github_activities WHERE delivery_id=$1",[`${p}-push`]); assert.equal(stored.rowCount,1); assert.equal(stored.rows[0].suggested_task_status,"DOING"); const before=(await pool.query("SELECT status FROM research_board_tasks WHERE id=$1",[ids.task])).rows[0].status; assert.equal(before,"TO DO");
        const key=(await pool.query("SELECT task_key FROM research_board_tasks WHERE id=$1",[ids.task])).rows[0].task_key; const pr=await webhook(`${p}-pr`,{repository:{id:42,full_name:"acme/demo",owner:{login:"acme"},name:"demo"},action:"closed",sender:{login:"dev"},pull_request:{number:3,title:`[${key}] ready`,body:"",state:"closed",merged:true,head:{ref:`feature/${key}`},html_url:"https://github/pr/3",updated_at:"2026-09-11T00:00:00Z"}},"pull_request"); assert.equal(pr.status,200); const pa=(await pool.query("SELECT * FROM research_github_activities WHERE delivery_id=$1",[`${p}-pr`])).rows[0]; assert.equal(pa.suggested_task_status,"DONE"); assert.equal((await pool.query("SELECT status FROM research_board_tasks WHERE id=$1",[ids.task])).rows[0].status,"TO DO");
        const raw=Buffer.from(JSON.stringify({repository:{full_name:"acme/demo"},commits:[]})); const equivalent=await webhook(`${p}-raw`,{repository:{full_name:"acme/demo"},commits:[]},"push",Buffer.from('{ "repository": {"full_name":"acme/demo"}, "commits": [] }')); assert.equal(equivalent.status,401);
      });
      await t.test("failed claim transaction rolls back and retry persists exactly once", async () => {
        const delivery = `${p}-atomic-retry`;
        const key = (await pool.query("SELECT task_key FROM research_board_tasks WHERE id=$1",[ids.task])).rows[0].task_key;
        const payload = {repository:{id:42,full_name:"acme/demo",owner:{login:"acme"},name:"demo"},ref:"refs/heads/main",commits:[{id:"atomic",message:key}]};
        failOnceDelivery = delivery;
        assert.equal((await webhook(delivery,payload)).status,500);
        assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM research_github_webhook_deliveries WHERE delivery_id=$1",[delivery])).rows[0].count,0);
        assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM research_github_activities WHERE delivery_id=$1",[delivery])).rows[0].count,0);
        assert.equal((await webhook(delivery,payload)).status,200);
        assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM research_github_activities WHERE delivery_id=$1",[delivery])).rows[0].count,1);
      });
      await t.test("PR lifecycle variants and merged regression preserve task status", async () => {
        const key=(await pool.query("SELECT task_key FROM research_board_tasks WHERE id=$1",[ids.task])).rows[0].task_key;
        for (const [action, merged, expectedType, expectedSuggestion] of [["opened",false,"pull_request_opened","REVIEW"],["reopened",false,"pull_request_reopened","REVIEW"],["synchronize",false,"pull_request_synchronize","REVIEW"],["closed",false,"pull_request_closed",null],["closed",true,"pull_request_merged","DONE"]]) {
          const delivery=`${p}-pr-${action}-${merged}`; const response=await webhook(delivery,{repository:{id:42,full_name:"acme/demo",owner:{login:"acme"},name:"demo"},action,sender:{login:"dev"},pull_request:{number:10,title:`[${key}] lifecycle`,body:`Implements ${key}`,state:"closed",merged,head:{ref:`feature/${key}`},html_url:"https://github/pr/10",updated_at:"2026-09-11T00:00:00Z"}},"pull_request"); assert.equal(response.status,200); const row=(await pool.query("SELECT * FROM research_github_activities WHERE delivery_id=$1",[delivery])).rows[0]; assert.equal(row.activity_type,expectedType); assert.equal(row.suggested_task_status,expectedSuggestion); assert.equal((await pool.query("SELECT status FROM research_board_tasks WHERE id=$1",[ids.task])).rows[0].status,"TO DO");
        }
      });
      await t.test("historical Sprint filter, evaluation immutability, and multiple-key determinism", async () => {
        const key=(await pool.query("SELECT task_key FROM research_board_tasks WHERE id=$1",[ids.task])).rows[0].task_key; const second=`${p}-TASK-2`; await pool.query("INSERT INTO research_board_tasks(id,project_id,title,status) VALUES($1,$2,'Second','TO DO')",[second,ids.project]); const secondKey=(await pool.query("SELECT task_key FROM research_board_tasks WHERE id=$1",[second])).rows[0].task_key;
        await pool.query("UPDATE research_board_tasks SET sprint_id=$2 WHERE id=$1",[ids.task,`${p}-S2`]); const multi=await webhook(`${p}-multi`,{repository:{id:42,full_name:"acme/demo",owner:{login:"acme"},name:"demo"},ref:"refs/heads/main",commits:[{id:"multi",message:`${key} ${secondKey} ${key}`} ]}); assert.equal(multi.status,200); const linked=(await pool.query("SELECT task_id FROM research_github_activities WHERE delivery_id=$1",[`${p}-multi`])).rows; assert.equal(linked.length,1); assert.equal(linked[0].task_id,ids.task);
        const source=await api("GET",`/research/${ids.project}/github-activity?sprintId=${p}-S1`); assert.equal(source.status,200); assert.ok(source.body.some(row=>row.task_id===ids.task));
        const before=(await pool.query("SELECT evaluated_user_id,task_completion,quality,timeliness,collaboration,initiative,overall_score,notes FROM research_sprint_member_evaluations WHERE sprint_id=$1",[`${p}-S1`])).rows; await webhook(`${p}-eval-push`,{repository:{id:42,full_name:"acme/demo",owner:{login:"acme"},name:"demo"},ref:"refs/heads/main",commits:[{id:"eval",message:key}]}); const after=(await pool.query("SELECT evaluated_user_id,task_completion,quality,timeliness,collaboration,initiative,overall_score,notes FROM research_sprint_member_evaluations WHERE sprint_id=$1",[`${p}-S1`])).rows; assert.deepEqual(after,before);
      });
      await t.test("delivery deduplication is concurrency-safe and activity API is authorized", async () => { const payload={repository:{id:42,full_name:"acme/demo",owner:{login:"acme"},name:"demo"},ref:"refs/heads/main",commits:[{id:"dup",message:"TASK-1"}]}; const out=await Promise.all([webhook(`${p}-parallel`,payload),webhook(`${p}-parallel`,payload)]); assert.deepEqual(out.map(x=>x.status).sort(),[200,200]); assert.equal((await pool.query("SELECT COUNT(*) FROM research_github_activities WHERE delivery_id=$1",[`${p}-parallel`])).rows[0].count,"1"); const activity=await api("GET",`/research/${ids.project}/github-activity`); assert.equal(activity.status,200); const denied=await api("GET",`/research/${ids.other}/github-activity`,undefined,headers("mahasiswa",ids.student)); assert.equal(denied.status,403); });
    } finally { if(server) await new Promise(resolve=>server.close(resolve)); await pool.query("DELETE FROM research_projects WHERE id=ANY($1::text[])",[[ids.project,ids.other]]).catch(()=>{}); await pool.query("DELETE FROM users WHERE id=ANY($1::text[])",[[ids.manager,ids.lecturer,ids.student]]).catch(()=>{}); await pool.end(); }
  });
}
