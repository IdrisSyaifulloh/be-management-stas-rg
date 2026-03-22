const fs = require("fs");
const path = require("path");
const { pool } = require("./pool");

async function run() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error("SQL file path is required. Example: node ./db/runSqlFile.js ./db/schema.sql");
  }

  const absolutePath = path.isAbsolute(inputPath)
    ? inputPath
    : path.join(__dirname, "..", inputPath);

  const sql = fs.readFileSync(absolutePath, "utf8");
  await pool.query(sql);
  console.log(`Executed SQL file: ${absolutePath}`);
  await pool.end();
}

run().catch(async (error) => {
  console.error("Failed to execute SQL:", error.stack || error);
  await pool.end();
  process.exit(1);
});
