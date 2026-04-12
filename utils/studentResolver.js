const { query } = require("../db/pool");

function normalizeStudentLookupInput(value) {
  return String(value || "").trim();
}

async function resolveStudentRecord(studentIdOrUserId) {
  const lookupValue = normalizeStudentLookupInput(studentIdOrUserId);
  if (!lookupValue) return null;

  const result = await query(
    `
    SELECT s.id, s.user_id, s.nim, u.name
    FROM students s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = $1 OR s.user_id = $1
    LIMIT 1
    `,
    [lookupValue]
  );

  if (result.rowCount === 0) return null;
  return result.rows[0];
}

async function resolveStudentId(studentIdOrUserId) {
  const student = await resolveStudentRecord(studentIdOrUserId);
  return student?.id || null;
}

module.exports = {
  resolveStudentId,
  resolveStudentRecord
};
