const crypto = require("crypto");
const { pool } = require("../db/pool");
const { requireSafeId } = require("./securityValidation");
const { buildStudentKey } = require("./documentCenterIdentity");
const { createDocumentCenterDraft } = require("./documentCenterDraftUpload");

const COMPLETION_DEFINITION_ID = "DCDEF-COMPLETE-NORMAL-01";
const CERTIFICATE_DEFINITION_ID = "DCDEF-CERT-NORMAL-01";
const CASE_STATUSES = ["pending", "draft_created", "issued", "revoked"];
const DOCUMENT_PURPOSES = ["completion_letter", "certificate"];
const ACTIVITY_TYPES = ["Magang", "Riset"];
const MAX_BATCH_ITEMS = 50;

function httpError(statusCode, message, field = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (field) error.field = field;
  return error;
}

function bad(field) {
  throw httpError(400, "Input tidak valid.", field);
}

function safeId(value, field) {
  if (typeof value !== "string" || value.trim() !== value) bad(field);
  return requireSafeId(value, field);
}

function parseLimit(value) {
  if (value == null || value === "") return 20;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) bad("limit");
  return parsed;
}

function parseOffset(value) {
  if (value == null || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10000) bad("offset");
  return parsed;
}

function optionalSearch(value) {
  if (value == null || value === "") return null;
  const normalized = String(value).trim();
  if (normalized.length > 120 || /[\x00-\x1F\x7F]/.test(normalized)) bad("search");
  return normalized || null;
}

function requireActivityType(value) {
  if (!ACTIVITY_TYPES.includes(value)) bad("activityType");
  return value;
}

function optionalEnum(value, allowed, field) {
  if (value == null || value === "") return null;
  if (!allowed.includes(value)) bad(field);
  return value;
}

function requirePlainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad(field);
  return value;
}

function rejectUnexpectedFields(value, allowed, field) {
  for (const key of Object.keys(value || {})) {
    if (!allowed.has(key)) bad(field);
  }
}

function periodText(period) {
  return `${period.activityType}: ${period.startDate}${period.endDate ? ` s.d. ${period.endDate}` : ""}`;
}

function mapDocument(row, prefix) {
  if (!row[`${prefix}_document_id`]) return null;
  const version = row[`${prefix}_document_version`];
  return {
    id: row[`${prefix}_document_id`],
    title: row[`${prefix}_document_title`] || null,
    documentNumber: row[`${prefix}_document_number`] || null,
    status: row[`${prefix}_document_status`] || null,
    currentVersionNumber: version || null,
    canDownload: Number(version) > 0,
    issuedAt: row[`${prefix}_document_issued_at`] || null
  };
}

function mapCaseRow(row) {
  return {
    id: row.id,
    student: {
      name: row.student_snapshot?.name || null,
      nim: row.student_snapshot?.nim || null,
      prodi: row.student_snapshot?.prodi || null
    },
    activityType: row.activity_type,
    period: {
      activityType: row.period_snapshot?.activityType || row.activity_type,
      startDate: row.period_snapshot?.startDate || null,
      endDate: row.period_snapshot?.endDate || null,
      description: row.period_snapshot?.description || null
    },
    outcome: row.outcome,
    status: row.case_status,
    statusLabel: ({ pending: "Belum Ada Draft", draft_created: "Draft Dibuat", issued: "Terbit", revoked: "Dicabut" })[row.case_status] || row.case_status,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completionDocument: mapDocument(row, "completion"),
    capabilities: {
      canUploadCompletion: row.case_status === "pending" && !row.completion_document_id,
      canPublishCompletion: row.case_status === "draft_created" && Number(row.completion_document_version) > 0 && row.completion_document_status === "draft"
    }
  };
}

function mapProjectRow(row) {
  return {
    id: row.id,
    project: {
      title: row.project_snapshot?.title || null,
      shortTitle: row.project_snapshot?.shortTitle || null,
      status: row.project_snapshot?.status || null,
      role: row.project_snapshot?.role || null,
      joinedAt: row.project_snapshot?.joinedAt || null,
      completedAt: row.project_snapshot?.completedAt || null
    },
    certificateRequired: row.certificate_required,
    certificateStatus: row.certificate_status,
    displayOrder: row.display_order,
    createdAt: row.created_at,
    certificateDocument: mapDocument(row, "certificate"),
    capabilities: {
      canUploadCertificate: row.certificate_required === true && row.certificate_status === "pending" && !row.certificate_document_id,
      canPublishCertificate: row.certificate_status === "draft_created" && Number(row.certificate_document_version) > 0 && row.certificate_document_status === "draft"
    }
  };
}

async function requireActiveDefinition(client, id, purpose, requestMode) {
  const result = await client.query(
    `SELECT id, document_purpose, request_mode, is_active
     FROM dc_document_definitions
     WHERE id = $1 AND document_purpose = $2 AND request_mode = $3 AND is_active = TRUE
     LIMIT 1`,
    [id, purpose, requestMode]
  );
  if (!result.rowCount) throw httpError(409, "Definition dokumen tidak aktif atau tidak ditemukan.");
  return result.rows[0];
}

function buildStudentSnapshot(row) {
  return {
    legacyStudentId: row.student_id,
    name: row.student_name,
    nim: row.nim,
    prodi: row.prodi || null,
    studentStatus: row.student_status,
    studentActivityType: row.student_activity_type
  };
}

function buildPeriodSnapshot(row) {
  return {
    source: "legacy",
    legacyPeriodId: row.period_id,
    activityType: row.period_activity_type,
    startDate: row.period_start_date,
    endDate: row.period_end_date || null,
    description: row.period_description || null
  };
}

function buildProjectSnapshot(row) {
  return {
    legacyProjectId: row.project_id,
    title: row.project_title,
    shortTitle: row.project_short_title || null,
    periodText: row.project_period_text || null,
    status: row.project_status || null,
    membershipStatus: row.membership_status || null,
    role: row.project_role || null,
    joinedAt: row.project_joined_at || null,
    completedAt: row.project_completed_at || null,
    graduationProjectTitle: row.graduation_project_title || null
  };
}

async function loadEligibleContext(client, { studentId, periodId }) {
  const result = await client.query(
    `
    SELECT s.id AS student_id, s.user_id, s.nim, s.status AS student_status,
           s.tipe AS student_activity_type, u.name AS student_name, u.prodi,
           gs.id AS graduation_submission_id,
           TO_CHAR(gs.graduation_completed_at, 'YYYY-MM-DD') AS completed_at,
           sp.id AS period_id, sp.tipe AS period_activity_type,
           TO_CHAR(sp.mulai, 'YYYY-MM-DD') AS period_start_date,
           TO_CHAR(sp.selesai, 'YYYY-MM-DD') AS period_end_date,
           sp.keterangan AS period_description
    FROM students s
    JOIN users u ON u.id = s.user_id
    JOIN graduation_submissions gs ON gs.student_id = s.id
    JOIN student_periods sp ON sp.student_id = s.id
    WHERE s.id = $1
      AND sp.id = $2
      AND s.status = 'Alumni'
      AND gs.graduation_completed_at IS NOT NULL
    LIMIT 1
    `,
    [studentId, periodId]
  );
  return result.rows[0] || null;
}

async function loadEligibleProjects(client, studentId) {
  const result = await client.query(
    `
    SELECT DISTINCT gsp.project_id, gsp.project_title AS graduation_project_title,
           rp.title AS project_title, rp.short_title AS project_short_title,
           rp.period_text AS project_period_text, rp.status AS project_status,
           rm.status AS membership_status, rm.peran AS project_role,
           TO_CHAR(rm.bergabung, 'YYYY-MM-DD') AS project_joined_at,
           TO_CHAR(rm.selesai, 'YYYY-MM-DD') AS project_completed_at
    FROM graduation_submission_projects gsp
    JOIN students s ON s.id = gsp.student_id
    JOIN research_memberships rm
      ON rm.user_id = s.user_id
     AND rm.project_id = gsp.project_id
     AND rm.member_type = 'Mahasiswa'
    JOIN research_projects rp ON rp.id = gsp.project_id
    WHERE gsp.student_id = $1
    ORDER BY project_short_title, project_title, gsp.project_id
    `,
    [studentId]
  );
  return result.rows;
}

async function listEligible(rawQuery) {
  const activityType = requireActivityType(rawQuery.activityType);
  const periodId = rawQuery.periodId ? safeId(rawQuery.periodId, "periodId") : null;
  const search = optionalSearch(rawQuery.search);
  const limit = parseLimit(rawQuery.limit);
  const offset = parseOffset(rawQuery.offset);
  const params = [activityType];
  const predicates = [
    "s.status = 'Alumni'",
    "gs.graduation_completed_at IS NOT NULL",
    "sp.tipe = $1"
  ];
  if (periodId) {
    params.push(periodId);
    predicates.push(`sp.id = $${params.length}`);
  }
  if (search) {
    params.push(search);
    predicates.push(`(u.name ILIKE '%' || $${params.length} || '%' OR s.nim ILIKE '%' || $${params.length} || '%')`);
  }
  params.push(limit, offset);
  const result = await pool.query(
    `
    WITH filtered AS (
      SELECT s.id AS student_id, s.nim, u.name AS student_name, u.prodi,
             s.status AS student_status, s.tipe AS student_activity_type,
             sp.id AS period_id, sp.tipe AS period_activity_type,
             TO_CHAR(sp.mulai, 'YYYY-MM-DD') AS period_start_date,
             TO_CHAR(sp.selesai, 'YYYY-MM-DD') AS period_end_date,
             sp.keterangan AS period_description,
             TO_CHAR(gs.graduation_completed_at, 'YYYY-MM-DD') AS completed_at,
             COUNT(*) OVER() AS total_count
      FROM students s
      JOIN users u ON u.id = s.user_id
      JOIN graduation_submissions gs ON gs.student_id = s.id
      JOIN student_periods sp ON sp.student_id = s.id
      WHERE ${predicates.join(" AND ")}
      ORDER BY u.name ASC, s.id ASC, sp.mulai DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    )
    SELECT f.*,
           c.id AS case_id, c.case_status, c.completion_document_id,
           COALESCE(projects.items, '[]'::jsonb) AS projects
    FROM filtered f
    LEFT JOIN dc_final_activity_cases c
      ON c.legacy_student_id = f.student_id
     AND c.legacy_period_id = f.period_id
     AND c.completion_document_definition_id = $${params.length + 1}
     AND c.outcome = 'completed'
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'title', rp.title,
        'shortTitle', rp.short_title,
        'role', rm.peran,
        'status', rp.status,
        'membershipStatus', rm.status
      ) ORDER BY COALESCE(rp.short_title, rp.title), rp.id) AS items
      FROM graduation_submission_projects gsp
      JOIN students s ON s.id = gsp.student_id
      JOIN research_memberships rm ON rm.user_id = s.user_id AND rm.project_id = gsp.project_id AND rm.member_type = 'Mahasiswa'
      JOIN research_projects rp ON rp.id = gsp.project_id
      WHERE gsp.student_id = f.student_id
    ) projects ON TRUE
    ORDER BY f.student_name ASC, f.student_id ASC, f.period_start_date DESC
    `,
    [...params, COMPLETION_DEFINITION_ID]
  );
  return {
    items: result.rows.map((row) => ({
      student: { id: row.student_id, name: row.student_name, nim: row.nim, prodi: row.prodi || null, status: row.student_status },
      activityType: row.period_activity_type,
      period: { id: row.period_id, activityType: row.period_activity_type, startDate: row.period_start_date, endDate: row.period_end_date || null, description: row.period_description || null },
      completedAt: row.completed_at,
      projects: row.projects || [],
      existingCase: row.case_id ? { id: row.case_id, status: row.case_status, hasCompletionDocument: Boolean(row.completion_document_id) } : null
    })),
    pagination: { limit, offset, total: result.rowCount ? Number(result.rows[0].total_count) : 0 }
  };
}

async function insertAudit(client, { authUser, ip, event, target, detail }) {
  await client.query(
    `INSERT INTO audit_logs (id, user_id, user_role, action, target, ip, detail)
     VALUES ($1, $2, 'Operator', 'Create', $3, $4, $5::jsonb)`,
    [
      `AUD-DC-${crypto.randomUUID()}`,
      requireSafeId(authUser?.id, "userId"),
      target,
      ip || null,
      JSON.stringify({ module: "document_center", event, ...detail })
    ]
  );
}

async function createOneCase({ item, authUser, ip }) {
  const studentId = safeId(item.studentId, "studentId");
  const periodId = safeId(item.periodId, "periodId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await requireActiveDefinition(client, COMPLETION_DEFINITION_ID, "completion_letter", "alumni_sync");
    const certificateDefinition = await requireActiveDefinition(client, CERTIFICATE_DEFINITION_ID, "certificate", "alumni_sync");
    const context = await loadEligibleContext(client, { studentId, periodId });
    if (!context) {
      await client.query("ROLLBACK");
      return { studentId, periodId, status: "invalid", message: "Mahasiswa/periode tidak eligible." };
    }
    const projects = await loadEligibleProjects(client, studentId);
    const studentKey = buildStudentKey(context.student_id);
    const periodKey = `period:${context.period_id}`;
    const caseId = `DCFCASE-${crypto.randomUUID()}`;
    const completedAt = context.completed_at;
    const inserted = await client.query(
      `
      INSERT INTO dc_final_activity_cases (
        id, student_key, legacy_student_id, student_snapshot,
        activity_type, period_key, legacy_period_id, period_snapshot,
        outcome, case_status, completion_source, completed_at,
        completion_snapshot, completion_document_definition_id, created_by_user_id
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, 'completed',
              'pending', 'graduation_submission', $9::date, $10::jsonb, $11, $12)
      ON CONFLICT (student_key, completion_document_definition_id, activity_type, period_key, outcome)
      DO NOTHING
      RETURNING id
      `,
      [
        caseId,
        studentKey,
        context.student_id,
        JSON.stringify(buildStudentSnapshot(context)),
        context.period_activity_type,
        periodKey,
        context.period_id,
        JSON.stringify(buildPeriodSnapshot(context)),
        completedAt,
        JSON.stringify({ source: "graduation_submissions", graduationSubmissionId: context.graduation_submission_id, completedAt }),
        COMPLETION_DEFINITION_ID,
        requireSafeId(authUser?.id, "userId")
      ]
    );
    if (!inserted.rowCount) {
      const existing = await client.query(
        `SELECT id, case_status FROM dc_final_activity_cases
         WHERE student_key=$1 AND completion_document_definition_id=$2 AND activity_type=$3 AND period_key=$4 AND outcome='completed'
         LIMIT 1`,
        [studentKey, COMPLETION_DEFINITION_ID, context.period_activity_type, periodKey]
      );
      await client.query("ROLLBACK");
      return { studentId, periodId, status: "existing", caseId: existing.rows[0]?.id || null, caseStatus: existing.rows[0]?.case_status || null };
    }
    for (let index = 0; index < projects.length; index += 1) {
      const project = projects[index];
      await client.query(
        `
        INSERT INTO dc_final_activity_case_projects (
          id, final_activity_case_id, student_key, project_key, legacy_project_id,
          project_snapshot, certificate_required, certificate_document_definition_id,
          certificate_status, display_order
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, TRUE, $7, 'pending', $8)
        ON CONFLICT (final_activity_case_id, project_key) DO NOTHING
        `,
        [
          `DCFCPROJ-${crypto.randomUUID()}`,
          caseId,
          studentKey,
          `project:${project.project_id}`,
          project.project_id,
          JSON.stringify(buildProjectSnapshot(project)),
          certificateDefinition.id,
          index
        ]
      );
    }
    await insertAudit(client, {
      authUser,
      ip,
      event: "final_activity_case_created",
      target: "document_center_final_activity",
      detail: { caseId, studentId: context.student_id, periodId: context.period_id, outcome: "completed", projectCount: projects.length }
    });
    await client.query("COMMIT");
    return { studentId, periodId, status: "created", caseId, projectCount: projects.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error?.code === "23505") return { studentId, periodId, status: "existing" };
    throw error;
  } finally {
    client.release();
  }
}

async function createCases({ body, authUser, ip }) {
  requirePlainObject(body, "body");
  rejectUnexpectedFields(body, new Set(["items"]), "body");
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_BATCH_ITEMS) bad("items");
  const results = [];
  for (const raw of body.items) {
    try {
      requirePlainObject(raw, "items");
      rejectUnexpectedFields(raw, new Set(["studentId", "periodId"]), "items");
      results.push(await createOneCase({ item: { studentId: raw.studentId, periodId: raw.periodId }, authUser, ip }));
    } catch (error) {
      if (error?.statusCode === 400 || error?.statusCode === 404) {
        results.push({
          studentId: typeof raw?.studentId === "string" ? raw.studentId : null,
          periodId: typeof raw?.periodId === "string" ? raw.periodId : null,
          status: "invalid",
          message: error.message || "Input tidak valid."
        });
      } else {
        throw error;
      }
    }
  }
  return { items: results };
}

const CASE_SELECT = `
  SELECT c.*,
         cd.id AS completion_document_id,
         cd.title AS completion_document_title,
         cd.document_number AS completion_document_number,
         cd.status AS completion_document_status,
         cd.current_version_number AS completion_document_version,
         cd.issued_at AS completion_document_issued_at
  FROM dc_final_activity_cases c
  LEFT JOIN dc_official_documents cd ON cd.id = c.completion_document_id
`;

async function listCases(rawQuery) {
  const status = optionalEnum(rawQuery.status, CASE_STATUSES, "status");
  const activityType = rawQuery.activityType ? requireActivityType(rawQuery.activityType) : null;
  const documentPurpose = optionalEnum(rawQuery.documentPurpose, DOCUMENT_PURPOSES, "documentPurpose");
  const search = optionalSearch(rawQuery.search);
  const limit = parseLimit(rawQuery.limit);
  const offset = parseOffset(rawQuery.offset);
  const params = [];
  const predicates = [];
  if (status) { params.push(status); predicates.push(`c.case_status = $${params.length}`); }
  if (activityType) { params.push(activityType); predicates.push(`c.activity_type = $${params.length}`); }
  if (documentPurpose === "completion_letter") predicates.push("TRUE");
  if (documentPurpose === "certificate") predicates.push("EXISTS (SELECT 1 FROM dc_final_activity_case_projects cp WHERE cp.final_activity_case_id = c.id AND cp.certificate_required = TRUE)");
  if (search) {
    params.push(search);
    predicates.push(`(c.student_snapshot->>'name' ILIKE '%' || $${params.length} || '%' OR c.student_snapshot->>'nim' ILIKE '%' || $${params.length} || '%')`);
  }
  params.push(limit, offset);
  const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
  const result = await pool.query(
    `
    WITH filtered AS (
      SELECT c.id, COUNT(*) OVER() AS total_count
      FROM dc_final_activity_cases c
      ${where}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    )
    SELECT f.total_count, rows.*
    FROM filtered f
    JOIN LATERAL (${CASE_SELECT} WHERE c.id = f.id) rows ON TRUE
    ORDER BY rows.created_at DESC, rows.id DESC
    `,
    params
  );
  return { items: result.rows.map(mapCaseRow), pagination: { limit, offset, total: result.rowCount ? Number(result.rows[0].total_count) : 0 } };
}

async function detailCase(id) {
  const caseId = safeId(id, "id");
  const result = await pool.query(`${CASE_SELECT} WHERE c.id = $1 LIMIT 1`, [caseId]);
  if (!result.rowCount) throw httpError(404, "Case tidak ditemukan.");
  const projects = await pool.query(
    `
    SELECT cp.*,
           od.id AS certificate_document_id,
           od.title AS certificate_document_title,
           od.document_number AS certificate_document_number,
           od.status AS certificate_document_status,
           od.current_version_number AS certificate_document_version,
           od.issued_at AS certificate_document_issued_at
    FROM dc_final_activity_case_projects cp
    LEFT JOIN dc_official_documents od ON od.id = cp.certificate_document_id
    WHERE cp.final_activity_case_id = $1
    ORDER BY cp.display_order ASC, cp.id ASC
    `,
    [caseId]
  );
  return { ...mapCaseRow(result.rows[0]), projects: projects.rows.map(mapProjectRow) };
}

function parseDraftBody(body) {
  requirePlainObject(body, "body");
  rejectUnexpectedFields(body, new Set(["title", "fileName", "fileDataUrl"]), "body");
  return {
    title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : null,
    fileName: body.fileName,
    fileDataUrl: body.fileDataUrl
  };
}

async function uploadCompletionDraft({ id, body, authUser, ip }) {
  const parsed = parseDraftBody(body);
  const caseId = safeId(id, "id");
  const current = await detailCase(caseId);
  if (current.status !== "pending" || current.completionDocument) throw httpError(409, "Case tidak dapat dibuatkan draft.");
  const result = await createDocumentCenterDraft({
    authUser,
    ip,
    generatedFrom: "alumni_sync",
    body: {
      documentDefinitionId: COMPLETION_DEFINITION_ID,
      title: parsed.title || `Surat Keterangan Selesai - ${current.student.name || current.id}`,
      activityOutcome: "completed",
      fileName: parsed.fileName,
      fileDataUrl: parsed.fileDataUrl,
      participants: [{
        legacyStudentId: (await pool.query("SELECT legacy_student_id FROM dc_final_activity_cases WHERE id=$1", [caseId])).rows[0].legacy_student_id,
        period: { activityType: current.period.activityType, startDate: current.period.startDate, endDate: current.period.endDate }
      }]
    },
    onDraftCreated: async ({ client, documentId, operatorUserId }) => {
      const locked = await client.query("SELECT * FROM dc_final_activity_cases WHERE id=$1 FOR UPDATE", [caseId]);
      if (!locked.rowCount || locked.rows[0].case_status !== "pending" || locked.rows[0].completion_document_id) throw httpError(409, "Case tidak dapat dibuatkan draft.");
      await client.query(
        `UPDATE dc_final_activity_cases
         SET completion_document_id=$2, case_status='draft_created', updated_at=NOW()
         WHERE id=$1`,
        [caseId, documentId]
      );
      await insertAudit(client, { authUser: { id: operatorUserId }, ip, event: "final_activity_completion_draft_created", target: "document_center_final_activity", detail: { caseId, documentId } });
    }
  });
  return { document: result, case: await detailCase(caseId) };
}

async function uploadCertificateDraft({ id, body, authUser, ip }) {
  const parsed = parseDraftBody(body);
  const projectRowId = safeId(id, "id");
  const row = await pool.query(
    `SELECT cp.*, c.legacy_student_id, c.activity_type, c.period_snapshot, c.case_status,
            c.student_snapshot
     FROM dc_final_activity_case_projects cp
     JOIN dc_final_activity_cases c ON c.id = cp.final_activity_case_id
     WHERE cp.id=$1 LIMIT 1`,
    [projectRowId]
  );
  if (!row.rowCount) throw httpError(404, "Project case tidak ditemukan.");
  const project = row.rows[0];
  if (project.certificate_status !== "pending" || project.certificate_document_id || project.case_status === "revoked") throw httpError(409, "Sertifikat tidak dapat dibuatkan draft.");
  const period = project.period_snapshot;
  const result = await createDocumentCenterDraft({
    authUser,
    ip,
    generatedFrom: "alumni_sync",
    body: {
      documentDefinitionId: CERTIFICATE_DEFINITION_ID,
      title: parsed.title || `Sertifikat - ${project.student_snapshot?.name || project.legacy_student_id}`,
      activityOutcome: "completed",
      fileName: parsed.fileName,
      fileDataUrl: parsed.fileDataUrl,
      participants: [{
        legacyStudentId: project.legacy_student_id,
        legacyProjectId: project.legacy_project_id,
        period: { activityType: period.activityType, startDate: period.startDate, endDate: period.endDate }
      }]
    },
    onDraftCreated: async ({ client, documentId, operatorUserId }) => {
      const locked = await client.query("SELECT * FROM dc_final_activity_case_projects WHERE id=$1 FOR UPDATE", [projectRowId]);
      if (!locked.rowCount || locked.rows[0].certificate_status !== "pending" || locked.rows[0].certificate_document_id) throw httpError(409, "Sertifikat tidak dapat dibuatkan draft.");
      await client.query(
        `UPDATE dc_final_activity_case_projects
         SET certificate_document_id=$2, certificate_status='draft_created', updated_at=NOW()
         WHERE id=$1`,
        [projectRowId, documentId]
      );
      await insertAudit(client, { authUser: { id: operatorUserId }, ip, event: "final_activity_certificate_draft_created", target: "document_center_final_activity", detail: { caseProjectId: projectRowId, caseId: project.final_activity_case_id, documentId } });
    }
  });
  return { document: result, case: await detailCase(project.final_activity_case_id) };
}

async function markIssuedForPublishedDocument(client, { documentId, authUser, ip }) {
  const completion = await client.query("SELECT * FROM dc_final_activity_cases WHERE completion_document_id=$1 FOR UPDATE", [documentId]);
  if (completion.rowCount) {
    const row = completion.rows[0];
    if (row.case_status !== "draft_created") throw httpError(409, "Status case akhir kegiatan tidak konsisten.");
    await client.query("UPDATE dc_final_activity_cases SET case_status='issued', updated_at=NOW() WHERE id=$1", [row.id]);
    await insertAudit(client, { authUser, ip, event: "final_activity_completion_issued", target: "document_center_final_activity", detail: { caseId: row.id, documentId } });
  }
  const certificate = await client.query("SELECT * FROM dc_final_activity_case_projects WHERE certificate_document_id=$1 FOR UPDATE", [documentId]);
  if (certificate.rowCount) {
    const row = certificate.rows[0];
    if (row.certificate_status !== "draft_created") throw httpError(409, "Status sertifikat akhir kegiatan tidak konsisten.");
    await client.query("UPDATE dc_final_activity_case_projects SET certificate_status='issued', updated_at=NOW() WHERE id=$1", [row.id]);
    await insertAudit(client, { authUser, ip, event: "final_activity_certificate_issued", target: "document_center_final_activity", detail: { caseProjectId: row.id, caseId: row.final_activity_case_id, documentId } });
  }
}

module.exports = {
  listEligible,
  createCases,
  listCases,
  detailCase,
  uploadCompletionDraft,
  uploadCertificateDraft,
  markIssuedForPublishedDocument
};
