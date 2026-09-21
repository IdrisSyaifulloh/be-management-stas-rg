const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const enabled = process.env.RUN_SCRUM_V2_MIGRATION_TESTS === "true" && Boolean(process.env.TEST_DATABASE_URL);

if (!enabled) {
  test("Scrum V2 migration validation", { skip: "Set RUN_SCRUM_V2_MIGRATION_TESTS=true and TEST_DATABASE_URL." }, () => {});
} else {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.NODE_ENV = "test";
  const { pool } = require("../db/pool");
  const { runScrumV2Migrations } = require("../scripts/runScrumV2Migrations");
  const { prepareFreshScrumV2Database, resetPublicSchema } = require("./helpers/prepareScrumV2Database");

  async function integrityCounts() {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM (SELECT task_key FROM research_board_tasks GROUP BY task_key HAVING COUNT(*) > 1) duplicates) AS duplicate_task_keys,
        (SELECT COUNT(*) FROM (SELECT project_id FROM research_sprints WHERE status = 'active' GROUP BY project_id HAVING COUNT(*) > 1) duplicates) AS multiple_active_sprints,
        (SELECT COUNT(*) FROM research_sprint_task_assignments a LEFT JOIN research_sprints s ON s.id = a.sprint_id LEFT JOIN research_board_tasks t ON t.id = a.task_id WHERE s.id IS NULL OR t.id IS NULL) AS orphan_assignments,
        (SELECT COUNT(*) FROM research_task_repository_links l LEFT JOIN research_board_tasks t ON t.id = l.task_id LEFT JOIN research_repositories r ON r.id = l.repository_id WHERE t.id IS NULL OR r.id IS NULL OR t.project_id <> r.project_id) AS invalid_repository_links,
        (SELECT COUNT(*) FROM research_github_activities a LEFT JOIN research_repositories r ON r.id = a.repository_id LEFT JOIN research_github_webhook_deliveries d ON d.delivery_id = a.delivery_id WHERE r.id IS NULL OR d.delivery_id IS NULL) AS orphan_github_activities,
        (SELECT COUNT(*) FROM research_sprints WHERE status NOT IN ('planning','active','review','closed')) AS invalid_sprint_status,
        (SELECT COUNT(*) FROM research_sprint_member_evaluations WHERE task_completion NOT BETWEEN 1 AND 10 OR quality NOT BETWEEN 1 AND 10 OR timeliness NOT BETWEEN 1 AND 10 OR collaboration NOT BETWEEN 1 AND 10 OR initiative NOT BETWEEN 1 AND 10 OR overall_score NOT BETWEEN 1 AND 10) AS invalid_evaluation_scores
    `);
    return Object.fromEntries(Object.entries(result.rows[0]).map(([key, value]) => [key, Number(value)]));
  }

  test("supported pre-V2 baseline upgrades deterministically and is intentionally re-runnable", async () => {
    await resetPublicSchema(pool, process.env.TEST_DATABASE_URL);
    const baseline = fs.readFileSync(path.join(__dirname, "fixtures", "scrum_v2_pre_v2_baseline.sql"), "utf8");
    await pool.query(baseline);
    await runScrumV2Migrations(pool, { log: () => {} });
    await runScrumV2Migrations(pool, { log: () => {} });
    const migrated = await pool.query("SELECT task_key, division_id, sprint_id FROM research_board_tasks WHERE id = 'SCRUM-V2-BASELINE-TASK'");
    assert.equal(migrated.rowCount, 1);
    assert.match(migrated.rows[0].task_key, /^TASK-[0-9]+$/);
    assert.equal(migrated.rows[0].division_id, null);
    assert.equal(migrated.rows[0].sprint_id, null);
    assert.deepEqual(integrityCounts ? await integrityCounts() : {}, {
      duplicate_task_keys: 0,
      multiple_active_sprints: 0,
      orphan_assignments: 0,
      invalid_repository_links: 0,
      orphan_github_activities: 0,
      invalid_sprint_status: 0,
      invalid_evaluation_scores: 0
    });
  });

  test("fresh schema plus 029 through 033 passes all integrity checks", async () => {
    await prepareFreshScrumV2Database(pool, process.env.TEST_DATABASE_URL);
    assert.deepEqual(await integrityCounts(), {
      duplicate_task_keys: 0,
      multiple_active_sprints: 0,
      orphan_assignments: 0,
      invalid_repository_links: 0,
      orphan_github_activities: 0,
      invalid_sprint_status: 0,
      invalid_evaluation_scores: 0
    });
  });

  test.after(async () => {
    await pool.end();
  });
}
