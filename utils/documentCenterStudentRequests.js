const crypto = require("crypto");
const { pool, query } = require("../db/pool");
const { requireSafeId, parseBoundedLimit, parseBoundedOffset, requireEnum } = require("./securityValidation");
const { buildStudentKey } = require("./documentCenterIdentity");

const STATUSES = ["submitted", "revision_required", "approved", "rejected", "cancelled", "completed"];
const ALLOWED_PERIOD_TYPES = ["Magang", "Riset"];

function fail(message, statusCode = 400, field) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (field) error.field = field;
  throw error;
}

function requireObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== "object") fail("Input tidak valid.", 400, label);
  return value;
}

function allowOnly(value, keys, label = "body") {
  const object = requireObject(value, label);
  for (const key of Object.keys(object)) if (!keys.includes(key)) fail("Input tidak valid.", 400, key);
  return object;
}

function text(value, label, { required = false, max = 200 } = {}) {
  if (value == null) {
    if (required) fail("Input tidak valid.", 400, label);
    return null;
  }
  if (typeof value !== "string") fail("Input tidak valid.", 400, label);
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > max || /[\x00-\x1F\x7F]/.test(normalized)) fail("Input tidak valid.", 400, label);
  return normalized || null;
}

function date(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) fail("Input tidak valid.", 400, label);
  return value;
}

function mapDefinition(row) {
  return { id: row.id, typeCode: row.type_code, typeName: row.type_name, name: row.name, documentPurpose: row.document_purpose, activityType: row.activity_type || null, requiresProject: row.requires_project, requiresPeriod: row.requires_period };
}

async function resolveStudent(client, authUserId) {
  const userId = requireSafeId(authUserId, "userId");
  const result = await client.query(`SELECT s.id, s.nim, s.tipe, s.user_id, u.name, u.prodi FROM students s JOIN users u ON u.id = s.user_id WHERE s.user_id = $1 LIMIT 1`, [userId]);
  if (result.rowCount === 0) fail("Data mahasiswa tidak ditemukan.", 404);
  const row = result.rows[0];
  return { legacyStudentId: row.id, studentKey: buildStudentKey(row.id), userId: row.user_id, snapshot: { legacyStudentId: row.id, name: row.name || null, nim: row.nim || null, prodi: row.prodi || null, university: null, studentActivityType: row.tipe || null } };
}

async function resolveDefinition(client, definitionId) {
  const id = requireSafeId(definitionId, "definitionId");
  const result = await client.query(`SELECT id, type_code, type_name, name, document_purpose, activity_type, requires_project, requires_period FROM dc_document_definitions WHERE id = $1 AND is_active = TRUE AND request_mode = 'student_request' LIMIT 1`, [id]);
  if (result.rowCount === 0) fail("Definition tidak ditemukan.", 404);
  return result.rows[0];
}

async function periodsFor(client, studentId) {
  const result = await client.query(`SELECT id, tipe, mulai, selesai, keterangan FROM student_periods WHERE student_id = $1 ORDER BY mulai DESC, id ASC`, [studentId]);
  return result.rows;
}

async function projectsFor(client, userId) {
  const result = await client.query(`SELECT rp.id, rp.title, rp.short_title, rp.status, rm.peran, rm.status AS membership_status, rm.bergabung, rm.selesai FROM research_memberships rm JOIN research_projects rp ON rp.id = rm.project_id WHERE rm.user_id = $1 AND rm.member_type = 'Mahasiswa' ORDER BY rm.selesai DESC NULLS FIRST, rp.title ASC`, [userId]);
  return result.rows;
}

function parsePeriodInput(value) {
  const item = allowOnly(value, ["activityType", "startDate", "endDate"], "period");
  if (!ALLOWED_PERIOD_TYPES.includes(item.activityType)) fail("Input tidak valid.", 400, "activityType");
  const startDate = date(item.startDate, "startDate");
  const endDate = date(item.endDate, "endDate");
  if (startDate > endDate) fail("Input tidak valid.", 400, "period");
  return { activityType: item.activityType, startDate, endDate };
}

async function resolvePeriod(client, definition, student, suppliedPeriod, bodyHasPeriod) {
  if (!definition.requires_period) {
    if (bodyHasPeriod) fail("Input tidak valid.", 400, "period");
    return { periodKey: null, periodSnapshot: null, activityType: null };
  }
  const rows = await periodsFor(client, student.legacyStudentId);
  if (rows.length === 0) fail("Data periode kegiatan belum tersedia. Hubungi operator.", 409);
  if (rows.length === 1) {
    if (bodyHasPeriod) fail("Input tidak valid.", 400, "period");
    const row = rows[0];
    return { periodKey: `period:${row.id}`, activityType: row.tipe, periodSnapshot: { source: "legacy", legacyPeriodId: row.id, activityType: row.tipe, startDate: String(row.mulai).slice(0, 10), endDate: row.selesai ? String(row.selesai).slice(0, 10) : null, description: row.keterangan || null } };
  }
  if (!bodyHasPeriod) fail("Input tidak valid.", 400, "period");
  const period = parsePeriodInput(suppliedPeriod);
  const matches = rows.filter((row) => row.tipe === period.activityType && String(row.mulai).slice(0, 10) === period.startDate && (row.selesai ? String(row.selesai).slice(0, 10) : null) === period.endDate);
  if (matches.length === 0) fail("Input tidak valid.", 400, "period");
  if (matches.length > 1) fail("Data periode ambigu. Hubungi operator.", 409);
  const row = matches[0];
  return { periodKey: `period:${row.id}`, activityType: row.tipe, periodSnapshot: { source: "legacy", legacyPeriodId: row.id, activityType: row.tipe, startDate: String(row.mulai).slice(0, 10), endDate: row.selesai ? String(row.selesai).slice(0, 10) : null, description: row.keterangan || null } };
}

async function resolveProject(client, definition, student, value, hasValue) {
  if (!definition.requires_project) {
    if (hasValue) fail("Input tidak valid.", 400, "legacyProjectId");
    return { legacyProjectId: null, projectSnapshot: null };
  }
  const projectId = requireSafeId(value, "legacyProjectId");
  const projects = await projectsFor(client, student.userId);
  const project = projects.find((item) => item.id === projectId);
  if (!project) fail("Input tidak valid.", 400, "legacyProjectId");
  return { legacyProjectId: project.id, projectSnapshot: { legacyProjectId: project.id, title: project.title, shortTitle: project.short_title || null, projectStatus: project.status || null, role: project.peran || null, membershipStatus: project.membership_status || null, joinedAt: project.bergabung || null, completedAt: project.selesai || null } };
}

function statusLabel(status) { return ({ submitted: "Diajukan", revision_required: "Perlu Diperbaiki", approved: "Disetujui", rejected: "Ditolak", cancelled: "Dibatalkan", completed: "Selesai" })[status] || status; }
function jsonObject(value) { return value == null ? null : JSON.stringify(value); }

function mapRequest(row) {
  const completedDocument = row.status === "completed" && row.official_document_id && row.official_document_status && ["terbit", "diarsipkan"].includes(row.official_document_status) ? { id: row.official_document_id, title: row.official_document_title, documentNumber: row.official_document_number, status: row.official_document_status, issuedAt: row.official_document_issued_at, canDownload: Number(row.official_document_version) > 0 } : null;
  return { id: row.id, definition: { id: row.definition_id, name: row.definition_name, typeCode: row.type_code, documentPurpose: row.document_purpose }, subject: row.subject, status: row.status, statusLabel: statusLabel(row.status), studentNote: row.student_note || null, operatorNote: row.operator_note || null, activityType: row.activity_type || null, period: row.period_snapshot || null, project: row.project_snapshot || null, submittedAt: row.submitted_at, reviewedAt: row.reviewed_at, cancelledAt: row.cancelled_at, completedAt: row.completed_at, createdAt: row.created_at, updatedAt: row.updated_at, canEdit: row.status === "revision_required", canCancel: ["submitted", "revision_required"].includes(row.status), officialDocument: completedDocument };
}

const REQUEST_SELECT = `SELECT dr.*, dd.id AS definition_id, dd.name AS definition_name, dd.type_code, dd.document_purpose, od.status AS official_document_status, od.title AS official_document_title, od.document_number AS official_document_number, od.issued_at AS official_document_issued_at, od.current_version_number AS official_document_version FROM dc_document_requests dr JOIN dc_document_definitions dd ON dd.id = dr.document_definition_id LEFT JOIN dc_official_documents od ON od.id = dr.official_document_id AND dr.status = 'completed' AND od.status IN ('terbit','diarsipkan') AND EXISTS (SELECT 1 FROM dc_official_document_students ods WHERE ods.document_id = od.id AND ods.student_key = dr.student_key)`;

async function insertAudit(client, { id, authUser, event, action, definitionId }) {
  await client.query(`INSERT INTO audit_logs (id, user_id, user_role, action, target, detail) VALUES ($1, $2, 'Mahasiswa', $3, 'document_center_request', $4::jsonb)`, [`AUD-${crypto.randomUUID()}`, authUser.id, action, JSON.stringify({ module: "document_center", event, requestId: id, definitionId })]);
}

function parseWriteBody(body, edit = false) {
  const allowed = edit ? ["subject", "studentNote", "period", "legacyProjectId"] : ["documentDefinitionId", "subject", "studentNote", "period", "legacyProjectId"];
  const value = allowOnly(body || {}, allowed);
  const subject = text(value.subject, "subject", { required: true, max: 255 });
  const studentNote = text(value.studentNote, "studentNote", { max: 2000 });
  return { value, subject, studentNote };
}

async function getDefinitions() {
  const result = await query(`SELECT id, type_code, type_name, name, document_purpose, activity_type, requires_project, requires_period FROM dc_document_definitions WHERE is_active = TRUE AND request_mode = 'student_request' ORDER BY type_code, name, id`);
  return { items: result.rows.map(mapDefinition) };
}

async function getContext(authUserId, rawQuery) {
  const queryObject = allowOnly(rawQuery || {}, ["definitionId"], "query");
  const client = await pool.connect();
  try {
    const student = await resolveStudent(client, authUserId);
    const definition = await resolveDefinition(client, queryObject.definitionId);
    const periods = definition.requires_period ? await periodsFor(client, student.legacyStudentId) : [];
    const projects = definition.requires_project ? await projectsFor(client, student.userId) : [];
    return { definition: mapDefinition(definition), student: { name: student.snapshot.name, nim: student.snapshot.nim, prodi: student.snapshot.prodi, activityType: student.snapshot.studentActivityType }, periods: periods.map((row) => ({ activityType: row.tipe, startDate: String(row.mulai).slice(0, 10), endDate: row.selesai ? String(row.selesai).slice(0, 10) : null, description: row.keterangan || null })), projects: projects.map((row) => ({ title: row.title, shortTitle: row.short_title || null, projectStatus: row.status || null, membershipStatus: row.membership_status || null })), canSubmit: !definition.requires_period || periods.length > 0, blockingReason: definition.requires_period && periods.length === 0 ? "Data periode kegiatan belum tersedia. Hubungi operator." : null };
  } finally { client.release(); }
}

async function submitRequest({ authUser, body }) {
  const parsed = parseWriteBody(body, false);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const student = await resolveStudent(client, authUser.id);
    const definition = await resolveDefinition(client, parsed.value.documentDefinitionId);
    const period = await resolvePeriod(client, definition, student, parsed.value.period, Object.prototype.hasOwnProperty.call(parsed.value, "period"));
    const project = await resolveProject(client, definition, student, parsed.value.legacyProjectId, Object.prototype.hasOwnProperty.call(parsed.value, "legacyProjectId"));
    const id = `DCRQ-${crypto.randomUUID()}`;
    await client.query(`INSERT INTO dc_document_requests (id, document_definition_id, student_key, legacy_student_id, student_snapshot, status, subject, student_note, activity_type, period_key, period_snapshot, legacy_project_id, project_snapshot) VALUES ($1,$2,$3,$4,$5::jsonb,'submitted',$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb)`, [id, definition.id, student.studentKey, student.legacyStudentId, JSON.stringify(student.snapshot), parsed.subject, parsed.studentNote, period.activityType, period.periodKey, jsonObject(period.periodSnapshot), project.legacyProjectId, jsonObject(project.projectSnapshot)]);
    await insertAudit(client, { id, authUser, event: "document_request_submitted", action: "Create", definitionId: definition.id });
    const result = await client.query(`${REQUEST_SELECT} WHERE dr.id = $1 AND dr.student_key = $2`, [id, student.studentKey]);
    await client.query("COMMIT");
    return mapRequest(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505" && error.constraint === "dc_document_requests_active_context_unique") fail("Masih ada permintaan aktif untuk jenis dan periode yang sama.", 409);
    throw error;
  } finally { client.release(); }
}

async function listRequests(authUserId, rawQuery) {
  const source = allowOnly(rawQuery || {}, ["status", "definitionId", "limit", "offset"], "query");
  const client = await pool.connect();
  try {
    const student = await resolveStudent(client, authUserId);
    const status = requireEnum(source.status, STATUSES, "status");
    const definitionId = source.definitionId == null ? null : requireSafeId(source.definitionId, "definitionId");
    const limit = parseBoundedLimit(source.limit, 20, 100); const offset = parseBoundedOffset(source.offset, 0, 10000);
    const params = [student.studentKey]; const where = ["dr.student_key = $1"];
    if (status) { params.push(status); where.push(`dr.status = $${params.length}`); }
    if (definitionId) { params.push(definitionId); where.push(`dr.document_definition_id = $${params.length}`); }
    params.push(limit, offset);
    const result = await client.query(`WITH filtered AS (SELECT dr.id, COUNT(*) OVER() AS total_count FROM dc_document_requests dr WHERE ${where.join(" AND ")} ORDER BY dr.created_at DESC, dr.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}) ${REQUEST_SELECT} JOIN filtered f ON f.id = dr.id ORDER BY dr.created_at DESC, dr.id DESC`, params);
    return { items: result.rows.map(mapRequest), pagination: { limit, offset, total: result.rowCount ? Number(result.rows[0].total_count) : 0 } };
  } finally { client.release(); }
}

async function detailRequest(authUserId, id) {
  const client = await pool.connect();
  try { const student = await resolveStudent(client, authUserId); const result = await client.query(`${REQUEST_SELECT} WHERE dr.id = $1 AND dr.student_key = $2 LIMIT 1`, [requireSafeId(id, "id"), student.studentKey]); if (!result.rowCount) fail("Permintaan tidak ditemukan.", 404); return mapRequest(result.rows[0]); } finally { client.release(); }
}

async function editRequest({ authUser, id, body }) {
  const parsed = parseWriteBody(body, true); const client = await pool.connect();
  try { await client.query("BEGIN"); const student = await resolveStudent(client, authUser.id); const locked = await client.query(`SELECT * FROM dc_document_requests WHERE id = $1 AND student_key = $2 FOR UPDATE`, [requireSafeId(id, "id"), student.studentKey]); if (!locked.rowCount) fail("Permintaan tidak ditemukan.", 404); const request = locked.rows[0]; if (request.status !== "revision_required") fail("Permintaan tidak dapat diubah.", 409); const definition = await resolveDefinition(client, request.document_definition_id); const period = await resolvePeriod(client, definition, student, parsed.value.period, Object.prototype.hasOwnProperty.call(parsed.value, "period")); const project = await resolveProject(client, definition, student, parsed.value.legacyProjectId, Object.prototype.hasOwnProperty.call(parsed.value, "legacyProjectId")); await client.query(`UPDATE dc_document_requests SET subject=$3, student_note=$4, activity_type=$5, period_key=$6, period_snapshot=$7::jsonb, legacy_project_id=$8, project_snapshot=$9::jsonb, status='submitted', updated_at=NOW() WHERE id=$1 AND student_key=$2`, [request.id, student.studentKey, parsed.subject, parsed.studentNote, period.activityType, period.periodKey, jsonObject(period.periodSnapshot), project.legacyProjectId, jsonObject(project.projectSnapshot)]); await insertAudit(client, { id: request.id, authUser, event: "document_request_updated", action: "Update", definitionId: definition.id }); const result = await client.query(`${REQUEST_SELECT} WHERE dr.id=$1 AND dr.student_key=$2`, [request.id, student.studentKey]); await client.query("COMMIT"); return mapRequest(result.rows[0]); } catch (error) { await client.query("ROLLBACK").catch(() => {}); if (error.code === "23505" && error.constraint === "dc_document_requests_active_context_unique") fail("Masih ada permintaan aktif untuk jenis dan periode yang sama.", 409); throw error; } finally { client.release(); }
}

async function cancelRequest({ authUser, id, body }) {
  const payload = body == null ? {} : body;
  if (Array.isArray(payload) || typeof payload !== "object" || Object.keys(payload).length) fail("Input tidak valid.", 400);
  const client = await pool.connect();
  try { await client.query("BEGIN"); const student = await resolveStudent(client, authUser.id); const locked = await client.query(`SELECT id, status, document_definition_id FROM dc_document_requests WHERE id=$1 AND student_key=$2 FOR UPDATE`, [requireSafeId(id, "id"), student.studentKey]); if (!locked.rowCount) fail("Permintaan tidak ditemukan.", 404); const request = locked.rows[0]; if (!["submitted", "revision_required"].includes(request.status)) fail("Permintaan tidak dapat dibatalkan.", 409); await client.query(`UPDATE dc_document_requests SET status='cancelled', cancelled_at=NOW(), updated_at=NOW() WHERE id=$1`, [request.id]); await insertAudit(client, { id: request.id, authUser, event: "document_request_cancelled", action: "Update", definitionId: request.document_definition_id }); await client.query("COMMIT"); return { message: "Permintaan berhasil dibatalkan." }; } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
}

module.exports = { getDefinitions, getContext, submitRequest, listRequests, detailRequest, editRequest, cancelRequest };
