const db = require("../db/pool");

async function getWfhStudentSettings() {
  const result = await db.query(`
    SELECT 
      s.nim,
      u.name AS "studentName",
      COALESCE(s.wfh_quota, 0) AS "wfhQuota",
      true AS "hasSetting"
    FROM students s
    JOIN users u ON u.id = s.user_id
    ORDER BY u.name ASC
  `);

  return result.rows;
}

async function getDistinctStudents() {
  const result = await db.query(`
    SELECT 
      s.nim,
      u.name AS "studentName"
    FROM students s
    JOIN users u ON u.id = s.user_id
    ORDER BY u.name ASC
  `);

  return result.rows;
}

async function saveWfhStudentSettings(items) {
  if (!Array.isArray(items)) {
    return getWfhStudentSettings();
  }

  try {
    for (const item of items) {
      const nim = String(item.nim || "").trim();
      const wfhQuota = Math.max(0, Math.floor(Number(item.wfhQuota) || 0));

      if (!nim) continue;

      const result = await db.query(
        `
        UPDATE students
        SET wfh_quota = $2
        WHERE nim::text = $1
        `,
        [nim, wfhQuota]
      );

      if (result.rowCount === 0) {
        console.warn("[WFH SETTINGS] NIM tidak ditemukan:", nim);
      }
    }

    return getWfhStudentSettings();
  } catch (err) {
    console.error("[WFH SETTINGS] Error save:", err);
    throw err;
  }
}

module.exports = {
  getWfhStudentSettings,
  getDistinctStudents,
  saveWfhStudentSettings,
};