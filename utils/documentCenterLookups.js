const { query } = require("../db/pool");
const { requireSafeId } = require("./securityValidation");

function inputError() {
  const error = new Error("Input tidak valid.");
  error.statusCode = 400;
  return error;
}

function parsePage(value, fallback, maximum) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) throw inputError();
  return parsed;
}

function parseLimit(value) {
  if (value == null || value === "") return 20;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw inputError();
  return parsed;
}

async function requireStudent(studentId) {
  const result = await query("SELECT id FROM students WHERE id = $1 LIMIT 1", [studentId]);
  if (result.rowCount === 0) {
    const error = new Error("Mahasiswa tidak ditemukan.");
    error.statusCode = 404;
    throw error;
  }
}

async function listStudents({ search, limit, offset }) {
  const normalizedSearch = search == null ? "" : String(search).trim();
  if (normalizedSearch.length > 120 || /[\x00-\x1F\x7F]/.test(normalizedSearch)) throw inputError();
  const rowLimit = parseLimit(limit);
  const rowOffset = parsePage(offset, 0, 10000);
  const params = [];
  let where = "";
  if (normalizedSearch) {
    params.push(`%${normalizedSearch}%`);
    where = "WHERE u.name ILIKE $1 OR s.nim ILIKE $1 OR u.email ILIKE $1";
  }
  params.push(rowLimit + 1, rowOffset);
  const result = await query(`
    SELECT s.id, u.name, s.nim, u.prodi, s.tipe AS activity_type
    FROM students s JOIN users u ON u.id = s.user_id
    ${where}
    ORDER BY u.name ASC, s.id ASC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);
  const rows = result.rows.slice(0, rowLimit);
  return { items: rows.map((row) => ({ id: row.id, name: row.name, nim: row.nim, prodi: row.prodi || null, activityType: row.activity_type || null })), pagination: { limit: rowLimit, offset: rowOffset, hasMore: result.rows.length > rowLimit } };
}

async function listStudentPeriods(id) {
  const studentId = requireSafeId(id, "id");
  await requireStudent(studentId);
  const result = await query(`
    SELECT id, tipe AS activity_type, TO_CHAR(mulai, 'YYYY-MM-DD') AS start_date,
           TO_CHAR(selesai, 'YYYY-MM-DD') AS end_date, keterangan AS description
    FROM student_periods WHERE student_id = $1 ORDER BY mulai DESC, id ASC
  `, [studentId]);
  return { items: result.rows.map((row) => ({ id: row.id, activityType: row.activity_type, startDate: row.start_date, endDate: row.end_date || null, description: row.description || null })) };
}

async function listStudentProjects(id) {
  const studentId = requireSafeId(id, "id");
  await requireStudent(studentId);
  const result = await query(`
    SELECT rp.id, rp.title, rp.short_title, rp.period_text, rp.status AS project_status,
           rm.status AS membership_status, rm.peran, TO_CHAR(rm.bergabung, 'YYYY-MM-DD') AS joined_at,
           TO_CHAR(rm.selesai, 'YYYY-MM-DD') AS completed_at
    FROM students s JOIN research_memberships rm ON rm.user_id = s.user_id
    JOIN research_projects rp ON rp.id = rm.project_id
    WHERE s.id = $1 AND rm.member_type = 'Mahasiswa'
    ORDER BY rp.title ASC, rp.id ASC
  `, [studentId]);
  return { items: result.rows.map((row) => ({ id: row.id, title: row.title, shortTitle: row.short_title || null, periodText: row.period_text || null, projectStatus: row.project_status || null, membershipStatus: row.membership_status || null, role: row.peran || null, joinedAt: row.joined_at || null, completedAt: row.completed_at || null })) };
}

module.exports = { listStudents, listStudentPeriods, listStudentProjects };
