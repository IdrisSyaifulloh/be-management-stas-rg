const express = require("express");
const crypto = require("crypto");
const database = require("../../db/pool");
const { ensureResearchBoardTables } = require("../../utils/researchBoardStore");
const { extractTaskKeys } = require("../../utils/githubTaskReference");

function validSignature(req) {
  const secret = String(process.env.GITHUB_WEBHOOK_SECRET || "");
  const supplied = String(req.headers["x-hub-signature-256"] || "");
  if (!secret || !/^sha256=[0-9a-f]{64}$/i.test(supplied)) return false;
  const expected = crypto.createHmac("sha256", secret).update(req.rawBody || Buffer.alloc(0)).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(supplied.slice(7), "hex"), Buffer.from(expected, "hex"));
}

function deriveActivities(event, payload) {
  const activities = [];
  if (event === "push") {
    const branch = String(payload.ref || "").replace(/^refs\/heads\//, "");
    for (const commit of payload.commits || []) {
      activities.push({
        type: "push",
        branch,
        sha: commit.id,
        message: commit.message,
        url: commit.url,
        actor: payload.sender?.login,
        occurred: commit.timestamp,
        keyText: `${branch} ${commit.message}`
      });
    }
  }

  if (event === "pull_request" && ["opened", "reopened", "synchronize", "closed"].includes(payload.action)) {
    const pullRequest = payload.pull_request || {};
    const merged = payload.action === "closed" && pullRequest.merged === true;
    activities.push({
      type: merged ? "pull_request_merged" : `pull_request_${payload.action}`,
      branch: pullRequest.head?.ref,
      number: pullRequest.number,
      title: pullRequest.title,
      state: pullRequest.state,
      merged,
      url: pullRequest.html_url,
      actor: payload.sender?.login,
      occurred: pullRequest.updated_at,
      keyText: `${pullRequest.title || ""} ${pullRequest.body || ""} ${pullRequest.head?.ref || ""}`
    });
  }
  return activities;
}

function suggestedTaskStatus(activityType) {
  if (activityType === "push") return "DOING";
  if (activityType === "pull_request_merged") return "DONE";
  if (["pull_request_opened", "pull_request_reopened", "pull_request_synchronize"].includes(activityType)) return "REVIEW";
  return null;
}

function createRouter({ pool = database.pool, ensureTables = ensureResearchBoardTables, afterClaim } = {}) {
  const router = express.Router();

  router.post("/github/webhook", async (req, res, next) => {
    if (!validSignature(req)) return res.status(401).json({ message: "Signature webhook GitHub tidak valid." });
    const delivery = String(req.headers["x-github-delivery"] || "");
    const event = String(req.headers["x-github-event"] || "");
    if (!delivery || !event) return res.status(400).json({ message: "Header webhook tidak lengkap." });

    let client;
    try {
      await ensureTables();
      client = await pool.connect();
      await client.query("BEGIN");

      const payload = req.body || {};
      const githubRepository = payload.repository || {};
      const owner = githubRepository.owner?.login || githubRepository.full_name?.split("/")[0] || "";
      const name = githubRepository.name || githubRepository.full_name?.split("/")[1] || "";
      const repositoriesResult = await client.query(
        `SELECT * FROM research_repositories
         WHERE removed_at IS NULL
           AND is_active = TRUE
           AND ((github_repository_id = $1 AND $1 IS NOT NULL) OR (LOWER(github_owner) = LOWER($2) AND LOWER(github_repo) = LOWER($3)))
         ORDER BY id ASC`,
        [githubRepository.id ? String(githubRepository.id) : null, owner, name]
      );

      if (repositoriesResult.rowCount === 0) {
        const ignored = await client.query(
          "INSERT INTO research_github_webhook_deliveries(delivery_id,event_name,status,processed_at) VALUES($1,$2,'ignored',NOW()) ON CONFLICT DO NOTHING RETURNING delivery_id",
          [delivery, event]
        );
        await client.query("COMMIT");
        return res.json(ignored.rowCount === 0
          ? { ignored: true, duplicate: true }
          : { ignored: true, reason: "unknown_repository" });
      }

      const repositories = repositoriesResult.rows;
      const primaryRepo = repositories[0];
      const claimed = await client.query(
        "INSERT INTO research_github_webhook_deliveries(delivery_id,event_name,repository_id,status) VALUES($1,$2,$3,'received') ON CONFLICT DO NOTHING RETURNING delivery_id",
        [delivery, event, primaryRepo.id]
      );
      if (claimed.rowCount === 0) {
        await client.query("COMMIT");
        return res.json({ ignored: true, duplicate: true });
      }

      for (const repo of repositories) {
        await client.query(
          "INSERT INTO research_github_delivery_repositories(delivery_id,repository_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [delivery, repo.id]
        );
      }

      if (afterClaim) await afterClaim({ client, delivery, event, repository: primaryRepo, repositories });

      const rawActivities = deriveActivities(event, payload);
      const seenKeys = new Set();
      const activities = [];
      for (const act of rawActivities) {
        const key = act.type === "push"
          ? `push:${act.sha || act.message}`
          : `${act.type}:${act.number}:${act.occurred}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          activities.push(act);
        }
      }

      let insertedActivitiesCount = 0;
      for (const repository of repositories) {
        for (const activity of activities) {
          const taskKey = extractTaskKeys(activity.keyText)[0];
          const taskResult = taskKey
            ? await client.query(
                "SELECT id FROM research_board_tasks WHERE project_id = $1 AND task_key = $2",
                [repository.project_id, taskKey]
              )
            : { rowCount: 0 };
          await client.query(
            `INSERT INTO research_github_activities
               (id,repository_id,task_id,delivery_id,activity_type,github_actor_login,branch_name,commit_sha,commit_message,
                pull_request_number,pull_request_title,pull_request_state,pull_request_merged,html_url,occurred_at,suggested_task_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
            [
              `GHA-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
              repository.id,
              taskResult.rowCount ? taskResult.rows[0].id : null,
              delivery,
              activity.type,
              activity.actor || null,
              activity.branch || null,
              activity.sha || null,
              activity.message || null,
              activity.number || null,
              activity.title || null,
              activity.state || null,
              activity.merged ?? null,
              activity.url || null,
              activity.occurred || null,
              suggestedTaskStatus(activity.type)
            ]
          );
          insertedActivitiesCount++;
        }
      }

      await client.query(
        "UPDATE research_github_webhook_deliveries SET status = 'processed', processed_at = NOW() WHERE delivery_id = $1",
        [delivery]
      );
      await client.query("COMMIT");
      return res.json({ processed: true, activities: insertedActivitiesCount, matchedRepositories: repositories.length });
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      return next(error);
    } finally {
      if (client) client.release();
    }
  });

  return router;
}

const router = createRouter();
router.createRouter = createRouter;
router.validSignature = validSignature;

module.exports = router;
