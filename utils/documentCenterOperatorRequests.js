const crypto = require("crypto");
const { pool } = require("../db/pool");
const { requireSafeId, requireEnum } = require("./securityValidation");

const STATUSES = ["submitted", "revision_required", "approved", "rejected", "cancelled", "completed"];

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

function parseLimit(value) {
  if (value == null || value === "") return 20;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) fail("Input tidak valid.", 400, "limit");
  return parsed;
}

function parseOffset(value) {
  if (value == null || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10000) fail("Input tidak valid.", 400, "offset");
  return parsed;
}

function parseSearch(value) {
  if (value == null || value === "") return null;
  return text(value, "search", { required: true, max: 120 });
}

function statusLabel(status) {
  return ({ submitted: "Diajukan", revision_required: "Perlu Diperbaiki", approved: "Disetujui", rejected: "Ditolak", cancelled: "Dibatalkan", completed: "Selesai" })[status] || status;
}

function capabilities(status) {
  return {
    canRequestRevision: status === "submitted",
    canApprove: ["submitted", "revision_required"].includes(status),
    canReject: ["submitted", "revision_required"].includes(status)
  };
}

function mapPeriod(row) {
  if (!row.period_snapshot) return null;
  return {
    source: row.period_source || null,
    activityType: row.period_activity_type || null,
    startDate: row.period_start_date || null,
    endDate: row.period_end_date || null,
    description: row.period_description || null
  };
}

function mapProject(row) {
  if (!row.project_snapshot) return null;
  return {
    title: row.project_title || null,
    shortTitle: row.project_short_title || null,
    projectStatus: row.project_status || null,
    role: row.project_role || null,
    membershipStatus: row.project_membership_status || null,
    joinedAt: row.project_joined_at || null,
    completedAt: row.project_completed_at || null
  };
}

function mapOfficialDocument(row) {
  if (!row.official_document_id) return null;
  return {
    id: row.official_document_id,
    title: row.official_document_title || null,
    documentNumber: row.official_document_number || null,
    status: row.official_document_status || null,
    issuedAt: row.official_document_issued_at || null
  };
}

function mapRequest(row, includeDetail = false) {
  const result = {
    id: row.id,
    definition: {
      id: row.definition_id,
      name: row.definition_name,
      typeCode: row.definition_type_code,
      documentPurpose: row.definition_document_purpose
    },
    student: {
      name: row.student_name || null,
      nim: row.student_nim || null,
      prodi: row.student_prodi || null,
      activityType: row.student_activity_type || null
    },
    subject: row.subject,
    status: row.status,
    statusLabel: statusLabel(row.status),
    activityType: row.activity_type || null,
    period: mapPeriod(row),
    project: mapProject(row),
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...capabilities(row.status)
  };

  if (includeDetail) {
    result.studentNote = row.student_note || null;
    result.operatorNote = row.operator_note || null;
    result.reviewedAt = row.reviewed_at || null;
    result.reviewedByName = row.reviewed_by_name || null;
    result.cancelledAt = row.cancelled_at || null;
    result.completedAt = row.completed_at || null;
    result.officialDocument = mapOfficialDocument(row);
  }

  return result;
}

const REQUEST_SELECT = `
  SELECT
    dr.id, dr.status, dr.subject, dr.student_note, dr.operator_note,
    dr.activity_type, dr.period_snapshot, dr.project_snapshot,
    dr.submitted_at, dr.reviewed_at, dr.cancelled_at, dr.completed_at,
    dr.created_at, dr.updated_at,
    dd.id AS definition_id, dd.name AS definition_name,
    dd.type_code AS definition_type_code,
    dd.document_purpose AS definition_document_purpose,
    dr.student_snapshot->>'name' AS student_name,
    dr.student_snapshot->>'nim' AS student_nim,
    dr.student_snapshot->>'prodi' AS student_prodi,
    dr.student_snapshot->>'studentActivityType' AS student_activity_type,
    dr.period_snapshot->>'source' AS period_source,
    dr.period_snapshot->>'activityType' AS period_activity_type,
    dr.period_snapshot->>'startDate' AS period_start_date,
    dr.period_snapshot->>'endDate' AS period_end_date,
    dr.period_snapshot->>'description' AS period_description,
    dr.project_snapshot->>'title' AS project_title,
    dr.project_snapshot->>'shortTitle' AS project_short_title,
    dr.project_snapshot->>'projectStatus' AS project_status,
    dr.project_snapshot->>'role' AS project_role,
    dr.project_snapshot->>'membershipStatus' AS project_membership_status,
    dr.project_snapshot->>'joinedAt' AS project_joined_at,
    dr.project_snapshot->>'completedAt' AS project_completed_at,
    reviewer.name AS reviewed_by_name,
    od.id AS official_document_id, od.title AS official_document_title,
    od.document_number AS official_document_number,
    od.status AS official_document_status,
    od.issued_at AS official_document_issued_at
  FROM dc_document_requests dr
  JOIN dc_document_definitions dd ON dd.id = dr.document_definition_id
  LEFT JOIN users reviewer ON reviewer.id = dr.reviewed_by_user_id
  LEFT JOIN dc_official_documents od ON od.id = dr.official_document_id
`;
const LIST_REQUEST_SELECT = REQUEST_SELECT.replace("SELECT\n", "SELECT\n    f.total_count,\n");

async function insertAudit(client, { authUser, request, event, action, previousStatus, newStatus }) {
  await client.query(
    `INSERT INTO audit_logs (id, user_id, user_role, action, target, detail)
     VALUES ($1, $2, 'Operator', $3, 'document_center_request', $4::jsonb)`,
    [
      `AUD-${crypto.randomUUID()}`,
      authUser.id,
      action,
      JSON.stringify({
        module: "document_center",
        event,
        requestId: request.id,
        definitionId: request.document_definition_id,
        previousStatus,
        newStatus
      })
    ]
  );
}

async function listRequests(rawQuery) {
  const source = allowOnly(rawQuery || {}, ["status", "definitionId", "search", "limit", "offset"], "query");
  const status = requireEnum(source.status, STATUSES, "status");
  const definitionId = source.definitionId == null || source.definitionId === "" ? null : requireSafeId(source.definitionId, "definitionId");
  const search = parseSearch(source.search);
  const limit = parseLimit(source.limit);
  const offset = parseOffset(source.offset);
  const params = [];
  const predicates = [];

  if (status) {
    params.push(status);
    predicates.push(`dr.status = $${params.length}`);
  }
  if (definitionId) {
    params.push(definitionId);
    predicates.push(`dr.document_definition_id = $${params.length}`);
  }
  if (search) {
    params.push(search);
    const position = params.length;
    predicates.push(`(dr.student_snapshot->>'name' ILIKE '%' || $${position} || '%' OR dr.student_snapshot->>'nim' ILIKE '%' || $${position} || '%' OR dr.subject ILIKE '%' || $${position} || '%')`);
  }
  params.push(limit, offset);
  const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  const result = await pool.query(
    `WITH filtered AS (
       SELECT dr.id, COUNT(*) OVER() AS total_count
       FROM dc_document_requests dr
       ${where}
       ORDER BY dr.created_at DESC, dr.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}
     )
     ${LIST_REQUEST_SELECT}
     JOIN filtered f ON f.id = dr.id
     ORDER BY dr.created_at DESC, dr.id DESC`,
    params
  );

  return {
    items: result.rows.map((row) => mapRequest(row)),
    pagination: { limit, offset, total: result.rowCount ? Number(result.rows[0].total_count) : 0 }
  };
}

async function detailRequest(id) {
  const result = await pool.query(`${REQUEST_SELECT} WHERE dr.id = $1 LIMIT 1`, [requireSafeId(id, "id")]);
  if (!result.rowCount) fail("Permintaan tidak ditemukan.", 404);
  return mapRequest(result.rows[0], true);
}

function parseActionBody(body, { noteRequired }) {
  const value = allowOnly(body == null ? {} : body, ["operatorNote"]);
  const hasNote = Object.prototype.hasOwnProperty.call(value, "operatorNote");
  if (noteRequired && !hasNote) fail("Input tidak valid.", 400, "operatorNote");
  return { operatorNote: hasNote ? text(value.operatorNote, "operatorNote", { required: true, max: 2000 }) : null };
}

async function transitionRequest({ authUser, id, body, transition }) {
  const parsed = parseActionBody(body, { noteRequired: transition.noteRequired });
  const requestId = requireSafeId(id, "id");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT id, status, document_definition_id
       FROM dc_document_requests
       WHERE id = $1
       FOR UPDATE`,
      [requestId]
    );
    if (!locked.rowCount) fail("Permintaan tidak ditemukan.", 404);
    const request = locked.rows[0];
    if (!transition.from.includes(request.status)) fail("Status permintaan tidak valid untuk aksi ini.", 409);

    await client.query(
      `UPDATE dc_document_requests
       SET status = $2,
           operator_note = $3,
           reviewed_at = NOW(),
           reviewed_by_user_id = $4,
           updated_at = NOW()
       WHERE id = $1`,
      [request.id, transition.to, parsed.operatorNote, authUser.id]
    );
    await insertAudit(client, {
      authUser,
      request,
      event: transition.event,
      action: transition.action,
      previousStatus: request.status,
      newStatus: transition.to
    });
    const result = await client.query(`${REQUEST_SELECT} WHERE dr.id = $1 LIMIT 1`, [request.id]);
    await client.query("COMMIT");
    return mapRequest(result.rows[0], true);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function requestRevision(input) {
  return transitionRequest({ ...input, transition: { from: ["submitted"], to: "revision_required", noteRequired: true, event: "document_request_revision_requested", action: "Update" } });
}

function approveRequest(input) {
  return transitionRequest({ ...input, transition: { from: ["submitted", "revision_required"], to: "approved", noteRequired: false, event: "document_request_approved", action: "Approve" } });
}

function rejectRequest(input) {
  return transitionRequest({ ...input, transition: { from: ["submitted", "revision_required"], to: "rejected", noteRequired: true, event: "document_request_rejected", action: "Update" } });
}

module.exports = { listRequests, detailRequest, requestRevision, approveRequest, rejectRequest };
