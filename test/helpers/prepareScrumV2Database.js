const fs = require("fs");
const path = require("path");
const { assertStagingEquivalentTarget } = require("../../scripts/scrumV2DatabaseSafety");
const { runScrumV2Migrations } = require("../../scripts/runScrumV2Migrations");

async function resetPublicSchema(pool, databaseUrl) {
  assertStagingEquivalentTarget(databaseUrl);
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
}

async function prepareFreshScrumV2Database(pool, databaseUrl) {
  await resetPublicSchema(pool, databaseUrl);
  const schema = fs.readFileSync(path.join(__dirname, "..", "..", "db", "schema.sql"), "utf8");
  await pool.query(schema);
  await runScrumV2Migrations(pool, { log: () => {} });
}

module.exports = { prepareFreshScrumV2Database, resetPublicSchema };
