const fs = require("fs");
const path = require("path");
const { assertStagingEquivalentTarget } = require("./scrumV2DatabaseSafety");

const MIGRATION_FILES = [
  "029_scrum_v2_core.sql",
  "030_sprint_review_summary.sql",
  "031_github_integration_scrum_v2.sql"
];

async function runScrumV2Migrations(executor, { log = console.log } = {}) {
  for (const filename of MIGRATION_FILES) {
    log(`Applying ${filename}`);
    const sql = fs.readFileSync(path.join(__dirname, "..", "db", "migrations", filename), "utf8");
    await executor.query(sql);
  }
}

async function main() {
  const stagingMode = process.argv.includes("--staging");
  const databaseUrl = process.env.DATABASE_URL || null;
  if (stagingMode) assertStagingEquivalentTarget(databaseUrl);

  const { pool } = require("../db/pool");
  try {
    await runScrumV2Migrations(pool);
    console.log("Scrum V2 migrations complete.");
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    const message = String(error?.message || "Migration failed.")
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]");
    console.error(`Scrum V2 migration failed: ${message}`);
    process.exitCode = 1;
  });
}

module.exports = { MIGRATION_FILES, runScrumV2Migrations };
