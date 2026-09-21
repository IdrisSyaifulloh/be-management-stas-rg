const fs = require("fs");
const path = require("path");
const { pool } = require("./pool");

let autoMigratePromise = null;

async function autoMigrateDatabase(clientOrPool = pool, { log = console.log, silent = false } = {}) {
  // 1. Create schema_migrations table if not exists
  await clientOrPool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 2. Fetch applied migrations
  const appliedResult = await clientOrPool.query(`SELECT filename FROM schema_migrations`);
  const applied = new Set(appliedResult.rows.map((r) => r.filename));

  // 3. Ensure baseline schema.sql is applied first if not yet tracked
  const schemaPath = path.join(__dirname, "schema.sql");
  if (!applied.has("schema.sql") && fs.existsSync(schemaPath)) {
    const schemaSql = fs.readFileSync(schemaPath, "utf8");
    try {
      await clientOrPool.query(schemaSql);
      await clientOrPool.query(
        `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING`,
        ["schema.sql"]
      );
      applied.add("schema.sql");
      if (!silent) log("[AutoMigrate] Baseline schema.sql applied successfully.");
    } catch (err) {
      if (!silent) log(`[AutoMigrate] Notice applying schema.sql: ${err.message}`);
    }
  }

  // 4. Read all migration files in db/migrations/
  const migrationsDir = path.join(__dirname, "migrations");
  if (fs.existsSync(migrationsDir)) {
    const files = fs.readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const filename of files) {
      if (applied.has(filename)) continue;

      const filePath = path.join(migrationsDir, filename);
      const sql = fs.readFileSync(filePath, "utf8");

      try {
        await clientOrPool.query(sql);
        await clientOrPool.query(
          `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING`,
          [filename]
        );
        applied.add(filename);
        if (!silent) log(`[AutoMigrate] Applied migration: ${filename}`);
      } catch (err) {
        if (!silent) log(`[AutoMigrate] Notice applying ${filename}: ${err.message}`);
        // If it failed because table/column/type/constraint already exists, mark as applied so it doesn't repeat
        if (/already exists/i.test(err.message) || /duplicate/i.test(err.message)) {
          await clientOrPool.query(
            `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING`,
            [filename]
          ).catch(() => {});
          applied.add(filename);
        }
      }
    }
  }

  // 5. Ensure runtime dynamic table utilities
  try {
    const { ensureGraduationSubmissionsTables } = require("../utils/graduationSubmissions");
    await ensureGraduationSubmissionsTables();
  } catch (err) {
    // ignore
  }

  try {
    const { ensurePicketTables } = require("../utils/picketService");
    await ensurePicketTables();
  } catch (err) {
    // ignore
  }

  try {
    const { ensureStudentDocumentsTable } = require("../utils/studentDocuments");
    await ensureStudentDocumentsTable();
  } catch (err) {
    // ignore
  }

  if (!silent) log("[AutoMigrate] Database auto-generation complete.");
  return true;
}

function ensureDatabaseAutoMigrated() {
  if (!autoMigratePromise) {
    autoMigratePromise = autoMigrateDatabase()
      .catch((err) => {
        // If database is unavailable, log and allow retry later
        console.warn("[AutoMigrate] Database connection not ready for auto-migration:", err.message);
        autoMigratePromise = null;
      });
  }
  return autoMigratePromise;
}

// If run directly as a CLI script: node ./db/autoMigrate.js
if (require.main === module) {
  autoMigrateDatabase(pool)
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error("[AutoMigrate] CLI Error:", err);
      await pool.end();
      process.exit(1);
    });
}

module.exports = {
  autoMigrateDatabase,
  ensureDatabaseAutoMigrated
};
