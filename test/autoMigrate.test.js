const test = require("node:test");
const assert = require("node:assert/strict");
const { autoMigrateDatabase, ensureDatabaseAutoMigrated } = require("../db/autoMigrate");

test("autoMigrateDatabase executes migrations and tracks them in schema_migrations", async () => {
  const executedQueries = [];
  const appliedSet = new Set(["schema.sql"]);

  const mockClient = {
    async query(text, params) {
      const q = String(text || "").trim();
      executedQueries.push({ text: q, params });

      if (q.includes("SELECT filename FROM schema_migrations")) {
        return {
          rowCount: appliedSet.size,
          rows: Array.from(appliedSet).map((filename) => ({ filename }))
        };
      }

      if (q.includes("INSERT INTO schema_migrations")) {
        const filename = params?.[0];
        if (filename) appliedSet.add(filename);
        return { rowCount: 1, rows: [] };
      }

      return { rowCount: 1, rows: [] };
    }
  };

  const result = await autoMigrateDatabase(mockClient, { silent: true });
  assert.equal(result, true);

  // Check that schema_migrations table was created if not exists
  const createTableQuery = executedQueries.find((q) => q.text.includes("CREATE TABLE IF NOT EXISTS schema_migrations"));
  assert.ok(createTableQuery, "Should ensure schema_migrations table exists");

  // Check that SELECT query was run to fetch existing migrations
  const selectQuery = executedQueries.find((q) => q.text.includes("SELECT filename FROM schema_migrations"));
  assert.ok(selectQuery, "Should query existing migrations");

  // Check that migrations were recorded
  const insertQueries = executedQueries.filter((q) => q.text.includes("INSERT INTO schema_migrations"));
  assert.ok(insertQueries.length > 0, "Should record applied migrations");
});

test("ensureDatabaseAutoMigrated returns a promise and does not throw if database is offline", async () => {
  const promise = ensureDatabaseAutoMigrated();
  assert.ok(promise instanceof Promise, "Should return a promise");
  // The promise catches offline DB errors internally and does not crash the server
  const result = await promise.catch((err) => err);
  assert.ok(result === undefined || result === null || result === true, "Should handle offline database without crashing");
});
