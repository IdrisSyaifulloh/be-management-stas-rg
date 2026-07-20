const crypto = require("crypto");
const fs = require("fs/promises");
const { pool } = require("../db/pool");
const { requireSafeId } = require("./securityValidation");
const { buildStudentKey } = require("./documentCenterIdentity");
const { createDocumentCenterDraft } = require("./documentCenterDraftUpload");
const {
  generateCertificateDraft,
  buildCertificateData,
  renderPublishedCertificateVersion
} = require("./documentCenterCertificateTemplates");
const {
  generateCompletionLetterDraft,
  buildLetterData,
  renderPublishedCompletionLetterVersion
} = require("./documentCenterCompletionLetterTemplates");
const {
  STAGING_ROOT,
  buildStagingFilePath,
  buildVersionStorageKey,
  buildVersionFilePath,
  getVersionDirectory
} = require("./documentCenterStorage");

const COMPLETION_DEFINITION_ID = "DCDEF-COMPLETE-NORMAL-01";
const CERTIFICATE_DEFINITION_ID = "DCDEF-CERT-NORMAL-01";
const EARLY_COMPLETION_DEFINITION_ID = "DCDEF-COMPLETE-EARLY-01";
const EARLY_CERTIFICATE_DEFINITION_ID = "DCDEF-CERT-EARLY-01";
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

function definitionIdsForOutcome(outcome) {
  if (outcome === "withdrawn_early") {
    return {
      completionDefinitionId: EARLY_COMPLETION_DEFINITION_ID,
      certificateDefinitionId: EARLY_CERTIFICATE_DEFINITION_ID,
      requestMode: "early_exit_review",
      generatedFrom: "early_exit_approved"
    };
  }
  return {
    completionDefinitionId: COMPLETION_DEFINITION_ID,
    certificateDefinitionId: CERTIFICATE_DEFINITION_ID,
    requestMode: "alumni_sync",
    generatedFrom: "alumni_sync"
  };
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
    certificateCount: Number(row.certificate_count || 0),
    certificateSummary: Array.isArray(row.certificate_summary) ? row.certificate_summary : [],
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
    source: row.period_source || "legacy",
    legacyPeriodId: row.period_id || null,
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
  const periodPredicate = periodId ? "AND sp.id = $2" : "";
  const sourcePredicate = periodId
    ? "sp.id IS NOT NULL"
    : "(sp.id IS NOT NULL OR pp.project_start_date IS NOT NULL OR pp.project_end_date IS NOT NULL OR s.bergabung IS NOT NULL OR gs.graduation_completed_at IS NOT NULL)";
  const params = periodId ? [studentId, periodId] : [studentId];
  const result = await client.query(
    `
    WITH project_period AS (
      SELECT ps.id AS student_id,
             MIN(rm.bergabung) AS project_start_date,
             MAX(COALESCE(rm.selesai, gs.graduation_completed_at::date, CURRENT_DATE)) AS project_end_date,
             STRING_AGG(DISTINCT COALESCE(rp.short_title, rp.title, gsp.project_title, rm.project_id), ', ' ORDER BY COALESCE(rp.short_title, rp.title, gsp.project_title, rm.project_id)) AS project_description
      FROM students ps
      JOIN graduation_submissions gs ON gs.student_id = ps.id
      JOIN research_memberships rm
        ON rm.user_id = ps.user_id
       AND rm.member_type = 'Mahasiswa'
      JOIN research_projects rp ON rp.id = rm.project_id
      LEFT JOIN graduation_submission_projects gsp
        ON gsp.student_id = ps.id
       AND gsp.project_id = rm.project_id
      WHERE ps.id = $1
        AND (
          NOT EXISTS (SELECT 1 FROM graduation_submission_projects WHERE student_id = ps.id)
          OR gsp.project_id IS NOT NULL
        )
      GROUP BY ps.id
    )
    SELECT s.id AS student_id, s.user_id, s.nim, s.status AS student_status,
           s.tipe AS student_activity_type, u.name AS student_name, u.prodi,
           gs.id AS graduation_submission_id,
           TO_CHAR(COALESCE(sp.selesai, pp.project_end_date, gs.graduation_completed_at::date, CURRENT_DATE), 'YYYY-MM-DD') AS completed_at,
           sp.id AS period_id,
           COALESCE(sp.tipe, s.tipe) AS period_activity_type,
           TO_CHAR(COALESCE(sp.mulai, pp.project_start_date, s.bergabung, gs.graduation_completed_at::date), 'YYYY-MM-DD') AS period_start_date,
           TO_CHAR(COALESCE(sp.selesai, pp.project_end_date, gs.graduation_completed_at::date), 'YYYY-MM-DD') AS period_end_date,
           COALESCE(sp.keterangan, pp.project_description, 'Periode dari relasi project mahasiswa') AS period_description,
           CASE WHEN sp.id IS NULL THEN 'project_membership' ELSE 'legacy' END AS period_source
    FROM students s
    JOIN users u ON u.id = s.user_id
    JOIN graduation_submissions gs ON gs.student_id = s.id
    LEFT JOIN LATERAL (
      SELECT sp.*
      FROM student_periods sp
      WHERE sp.student_id = s.id
        AND sp.tipe = s.tipe
        ${periodPredicate}
      ORDER BY sp.mulai DESC NULLS LAST, sp.id DESC
      LIMIT 1
    ) sp ON TRUE
    LEFT JOIN project_period pp ON pp.student_id = s.id
    WHERE s.id = $1
      AND s.status = 'Alumni'
      AND ${sourcePredicate}
    LIMIT 1
    `,
    params
  );
  return result.rows[0] || null;
}

async function loadEligibleProjects(client, studentId) {
  const result = await client.query(
    `
    WITH has_graduation_projects AS (
      SELECT EXISTS (
        SELECT 1
        FROM graduation_submission_projects
        WHERE student_id = $1
      ) AS has_projects
    )
    SELECT DISTINCT rm.project_id, gsp.project_title AS graduation_project_title,
           rp.title AS project_title, rp.short_title AS project_short_title,
           rp.period_text AS project_period_text, rp.status AS project_status,
           rm.status AS membership_status, rm.peran AS project_role,
           TO_CHAR(rm.bergabung, 'YYYY-MM-DD') AS project_joined_at,
           TO_CHAR(rm.selesai, 'YYYY-MM-DD') AS project_completed_at
    FROM students s
    JOIN research_memberships rm
      ON rm.user_id = s.user_id
     AND rm.member_type = 'Mahasiswa'
    JOIN research_projects rp ON rp.id = rm.project_id
    LEFT JOIN graduation_submission_projects gsp
      ON gsp.student_id = s.id
     AND gsp.project_id = rm.project_id
    CROSS JOIN has_graduation_projects hgp
    WHERE s.id = $1
      AND (hgp.has_projects = FALSE OR gsp.project_id IS NOT NULL)
    ORDER BY project_short_title, project_title, rm.project_id
    `,
    [studentId]
  );
  return result.rows;
}

async function loadWithdrawalContext(client, withdrawalRequestId) {
  const result = await client.query(
    `
    SELECT wr.id AS withdrawal_request_id, wr.student_id, wr.reason,
           wr.final_status, wr.status_dosen, wr.advisor_reviewed_at,
           s.user_id, s.nim, s.status AS student_status,
           s.tipe AS student_activity_type, s.withdrawal_at,
           u.name AS student_name, u.prodi,
           TO_CHAR(COALESCE(s.withdrawal_at, wr.advisor_reviewed_at), 'YYYY-MM-DD') AS effective_date
    FROM withdrawal_requests wr
    JOIN students s ON s.id = wr.student_id
    JOIN users u ON u.id = s.user_id
    WHERE wr.id = $1
    LIMIT 1
    `,
    [withdrawalRequestId]
  );
  return result.rows[0] || null;
}

async function loadWithdrawalPeriods(client, studentId, effectiveDate, activityType = null) {
  const params = [studentId, effectiveDate];
  const predicates = [
    "sp.student_id = $1",
    "sp.mulai <= $2::date",
    "(sp.selesai IS NULL OR sp.selesai >= $2::date)"
  ];
  if (activityType) {
    params.push(activityType);
    predicates.push(`sp.tipe = $${params.length}`);
  }
  const result = await client.query(
    `
    SELECT sp.id, sp.tipe,
           TO_CHAR(sp.mulai, 'YYYY-MM-DD') AS mulai,
           TO_CHAR(sp.selesai, 'YYYY-MM-DD') AS selesai,
           sp.keterangan
    FROM student_periods sp
    WHERE ${predicates.join(" AND ")}
    ORDER BY sp.mulai DESC, sp.id ASC
    `,
    params
  );
  return result.rows;
}

async function loadWithdrawalProjects(client, userId, effectiveDate) {
  const result = await client.query(
    `
    SELECT rp.id, rp.title, rp.short_title, rp.period_text,
           rp.status AS project_status,
           rm.status AS membership_status, rm.peran,
           TO_CHAR(rm.bergabung, 'YYYY-MM-DD') AS bergabung,
           TO_CHAR(rm.selesai, 'YYYY-MM-DD') AS selesai
    FROM research_memberships rm
    JOIN research_projects rp ON rp.id = rm.project_id
    WHERE rm.user_id = $1
      AND rm.member_type = 'Mahasiswa'
      AND (rm.bergabung IS NULL OR rm.bergabung <= $2::date)
    ORDER BY COALESCE(rp.short_title, rp.title), rp.id
    `,
    [userId, effectiveDate]
  );
  return result.rows;
}

function isFinalWithdrawal(context) {
  return Boolean(
    context &&
    context.final_status === "Disetujui" &&
    context.status_dosen === "Disetujui" &&
    context.student_status === "Mengundurkan Diri" &&
    context.effective_date
  );
}

function mapWithdrawalPeriod(row) {
  return {
    id: row.id,
    activityType: row.tipe,
    startDate: row.mulai,
    endDate: row.selesai || null,
    description: row.keterangan || null
  };
}

function mapWithdrawalProject(row) {
  return {
    id: row.id,
    title: row.title,
    shortTitle: row.short_title || null,
    projectStatus: row.project_status || null,
    membershipStatus: row.membership_status || null,
    role: row.peran || null,
    joinedAt: row.bergabung || null,
    completedAt: row.selesai || null
  };
}

function buildWithdrawalStudentSnapshot(context) {
  return {
    legacyStudentId: context.student_id,
    name: context.student_name,
    nim: context.nim,
    prodi: context.prodi || null,
    studentStatus: context.student_status,
    studentActivityType: context.student_activity_type
  };
}

function buildWithdrawalPeriodSnapshot(period) {
  return {
    source: "legacy",
    legacyPeriodId: period.id,
    activityType: period.tipe,
    startDate: period.mulai,
    endDate: period.selesai || null,
    description: period.keterangan || null
  };
}

function buildWithdrawalProjectSnapshot(project) {
  return {
    legacyProjectId: project.id,
    title: project.title,
    shortTitle: project.short_title || null,
    periodText: project.period_text || null,
    status: project.project_status || null,
    membershipStatus: project.membership_status || null,
    role: project.peran || null,
    joinedAt: project.bergabung || null,
    completedAt: project.selesai || null
  };
}

function mapWithdrawalCandidate(row) {
  const periods = row.eligible_periods || [];
  const projects = row.eligible_projects || [];
  let blockingReason = null;
  if (!row.effective_date) blockingReason = "Tanggal efektif pengunduran diri tidak tersedia.";
  else if (periods.length === 0) blockingReason = "Tidak ada periode mahasiswa yang mencakup tanggal efektif.";
  else if (periods.length > 1) blockingReason = "Terdapat lebih dari satu periode cocok; pilih periode saat registrasi.";
  else if (row.case_id) blockingReason = "Case early exit sudah terdaftar.";
  return {
    withdrawalRequestId: row.withdrawal_request_id,
    student: {
      id: row.student_id,
      name: row.student_name,
      nim: row.nim,
      prodi: row.prodi || null,
      status: row.student_status
    },
    activityType: row.period_activity_type || row.student_activity_type || null,
    effectiveDate: row.effective_date || null,
    reason: row.reason || null,
    finalStatus: row.final_status,
    periods,
    projects,
    existingCase: row.case_id ? {
      id: row.case_id,
      status: row.case_status,
      hasCompletionDocument: Boolean(row.completion_document_id)
    } : null,
    canRegister: !blockingReason,
    blockingReason
  };
}

async function listWithdrawalEligible(rawQuery) {
  const activityType = requireActivityType(rawQuery.activityType);
  const periodId = rawQuery.periodId ? safeId(rawQuery.periodId, "periodId") : null;
  const search = optionalSearch(rawQuery.search);
  const limit = parseLimit(rawQuery.limit);
  const offset = parseOffset(rawQuery.offset);
  const params = [activityType];
  const predicates = [
    "wr.final_status = 'Disetujui'",
    "wr.status_dosen = 'Disetujui'",
    "s.status = 'Mengundurkan Diri'",
    "COALESCE(s.withdrawal_at, wr.advisor_reviewed_at) IS NOT NULL",
    "s.tipe = $1"
  ];
  if (periodId) {
    params.push(periodId);
    predicates.push(`EXISTS (
      SELECT 1 FROM student_periods sp_filter
      WHERE sp_filter.id = $${params.length}
        AND sp_filter.student_id = s.id
        AND sp_filter.tipe = $1
        AND sp_filter.mulai <= COALESCE(s.withdrawal_at, wr.advisor_reviewed_at)::date
        AND (sp_filter.selesai IS NULL OR sp_filter.selesai >= COALESCE(s.withdrawal_at, wr.advisor_reviewed_at)::date)
    )`);
  }
  if (search) {
    params.push(search);
    predicates.push(`(u.name ILIKE '%' || $${params.length} || '%' OR s.nim ILIKE '%' || $${params.length} || '%')`);
  }
  params.push(limit, offset);
  const result = await pool.query(
    `
    WITH filtered AS (
      SELECT wr.id AS withdrawal_request_id, wr.student_id, wr.reason,
             wr.final_status, wr.status_dosen,
             s.user_id, s.nim, s.status AS student_status, s.tipe AS student_activity_type,
             u.name AS student_name, u.prodi,
             TO_CHAR(COALESCE(s.withdrawal_at, wr.advisor_reviewed_at), 'YYYY-MM-DD') AS effective_date,
             COUNT(*) OVER() AS total_count
      FROM withdrawal_requests wr
      JOIN students s ON s.id = wr.student_id
      JOIN users u ON u.id = s.user_id
      WHERE ${predicates.join(" AND ")}
      ORDER BY COALESCE(s.withdrawal_at, wr.advisor_reviewed_at) DESC, wr.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    )
    SELECT f.*,
           periods.items AS eligible_periods,
           projects.items AS eligible_projects,
           c.id AS case_id, c.case_status, c.completion_document_id,
           (periods.items->0->>'activityType') AS period_activity_type
    FROM filtered f
    LEFT JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', sp.id,
        'activityType', sp.tipe,
        'startDate', TO_CHAR(sp.mulai, 'YYYY-MM-DD'),
        'endDate', TO_CHAR(sp.selesai, 'YYYY-MM-DD'),
        'description', sp.keterangan
      ) ORDER BY sp.mulai DESC, sp.id ASC), '[]'::jsonb) AS items
      FROM student_periods sp
      WHERE sp.student_id = f.student_id
        AND sp.tipe = $1
        AND sp.mulai <= f.effective_date::date
        AND (sp.selesai IS NULL OR sp.selesai >= f.effective_date::date)
    ) periods ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', rp.id,
        'title', rp.title,
        'shortTitle', rp.short_title,
        'projectStatus', rp.status,
        'membershipStatus', rm.status,
        'role', rm.peran,
        'joinedAt', TO_CHAR(rm.bergabung, 'YYYY-MM-DD'),
        'completedAt', TO_CHAR(rm.selesai, 'YYYY-MM-DD')
      ) ORDER BY COALESCE(rp.short_title, rp.title), rp.id), '[]'::jsonb) AS items
      FROM research_memberships rm
      JOIN research_projects rp ON rp.id = rm.project_id
      WHERE rm.user_id = f.user_id
        AND rm.member_type = 'Mahasiswa'
        AND (rm.bergabung IS NULL OR rm.bergabung <= f.effective_date::date)
    ) projects ON TRUE
    LEFT JOIN dc_final_activity_cases c
      ON c.legacy_student_id = f.student_id
     AND c.completion_document_definition_id = $${params.length + 1}
     AND c.outcome = 'withdrawn_early'
     AND c.completion_snapshot->>'withdrawalRequestId' = f.withdrawal_request_id
    ORDER BY f.effective_date DESC, f.withdrawal_request_id DESC
    `,
    [...params, EARLY_COMPLETION_DEFINITION_ID]
  );
  return {
    items: result.rows.map(mapWithdrawalCandidate),
    pagination: { limit, offset, total: result.rowCount ? Number(result.rows[0].total_count) : 0 }
  };
}

async function createOneWithdrawalCase({ item, authUser, ip }) {
  const withdrawalRequestId = safeId(item.withdrawalRequestId, "withdrawalRequestId");
  const requestedPeriodId = item.periodId == null || item.periodId === "" ? null : safeId(item.periodId, "periodId");
  const certificateProjectIds = Array.isArray(item.certificateProjectIds) ? item.certificateProjectIds.map((value) => safeId(value, "certificateProjectIds")) : [];
  if (!Array.isArray(item.certificateProjectIds || [])) bad("certificateProjectIds");
  if (certificateProjectIds.length !== new Set(certificateProjectIds).size) bad("certificateProjectIds");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await requireActiveDefinition(client, EARLY_COMPLETION_DEFINITION_ID, "completion_letter", "early_exit_review");
    const certificateDefinition = await requireActiveDefinition(client, EARLY_CERTIFICATE_DEFINITION_ID, "certificate", "early_exit_review");
    const context = await loadWithdrawalContext(client, withdrawalRequestId);
    if (!context) {
      await client.query("ROLLBACK");
      return { withdrawalRequestId, status: "invalid", message: "Pengunduran diri tidak ditemukan." };
    }
    if (!isFinalWithdrawal(context)) {
      await client.query("ROLLBACK");
      return { withdrawalRequestId, status: "invalid", message: "Pengunduran diri belum final." };
    }
    const periods = await loadWithdrawalPeriods(client, context.student_id, context.effective_date);
    if (periods.length === 0) {
      await client.query("ROLLBACK");
      return { withdrawalRequestId, status: "invalid", message: "Tidak ada periode eligible." };
    }
    let period = null;
    if (requestedPeriodId) {
      period = periods.find((candidate) => candidate.id === requestedPeriodId) || null;
      if (!period) {
        await client.query("ROLLBACK");
        return { withdrawalRequestId, status: "invalid", message: "Periode tidak eligible." };
      }
    } else if (periods.length === 1) {
      period = periods[0];
    } else {
      await client.query("ROLLBACK");
      return { withdrawalRequestId, status: "invalid", message: "Periode ambigu dan wajib dipilih." };
    }
    const projects = await loadWithdrawalProjects(client, context.user_id, context.effective_date);
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    for (const projectId of certificateProjectIds) {
      if (!projectsById.has(projectId)) {
        await client.query("ROLLBACK");
        return { withdrawalRequestId, periodId: period.id, status: "invalid", message: "Project tidak eligible." };
      }
    }

    const studentKey = buildStudentKey(context.student_id);
    const periodKey = `period:${period.id}`;
    const caseId = `DCFCASE-${crypto.randomUUID()}`;
    const inserted = await client.query(
      `
      INSERT INTO dc_final_activity_cases (
        id, student_key, legacy_student_id, student_snapshot,
        activity_type, period_key, legacy_period_id, period_snapshot,
        outcome, case_status, completion_source, completed_at,
        completion_snapshot, completion_document_definition_id, created_by_user_id
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, 'withdrawn_early',
              'pending', 'withdrawal_approved', $9::date, $10::jsonb, $11, $12)
      ON CONFLICT (student_key, completion_document_definition_id, activity_type, period_key, outcome)
      DO NOTHING
      RETURNING id
      `,
      [
        caseId,
        studentKey,
        context.student_id,
        JSON.stringify(buildWithdrawalStudentSnapshot(context)),
        period.tipe,
        periodKey,
        period.id,
        JSON.stringify(buildWithdrawalPeriodSnapshot(period)),
        context.effective_date,
        JSON.stringify({
          source: "withdrawal_requests",
          withdrawalRequestId,
          effectiveDate: context.effective_date,
          reason: context.reason,
          finalStatus: context.final_status,
          advisorReviewedAt: context.advisor_reviewed_at || null
        }),
        EARLY_COMPLETION_DEFINITION_ID,
        requireSafeId(authUser?.id, "userId")
      ]
    );
    if (!inserted.rowCount) {
      const existing = await client.query(
        `SELECT id, case_status FROM dc_final_activity_cases
         WHERE student_key=$1 AND completion_document_definition_id=$2 AND activity_type=$3 AND period_key=$4 AND outcome='withdrawn_early'
         LIMIT 1`,
        [studentKey, EARLY_COMPLETION_DEFINITION_ID, period.tipe, periodKey]
      );
      await client.query("ROLLBACK");
      return { withdrawalRequestId, periodId: period.id, status: "existing", caseId: existing.rows[0]?.id || null, caseStatus: existing.rows[0]?.case_status || null };
    }
    for (let index = 0; index < certificateProjectIds.length; index += 1) {
      const project = projectsById.get(certificateProjectIds[index]);
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
          `project:${project.id}`,
          project.id,
          JSON.stringify(buildWithdrawalProjectSnapshot(project)),
          certificateDefinition.id,
          index
        ]
      );
    }
    await insertAudit(client, {
      authUser,
      ip,
      event: "final_activity_withdrawal_case_created",
      target: "document_center_final_activity",
      detail: { caseId, withdrawalRequestId, studentId: context.student_id, periodId: period.id, outcome: "withdrawn_early", certificateProjectCount: certificateProjectIds.length }
    });
    await client.query("COMMIT");
    return { withdrawalRequestId, periodId: period.id, status: "created", caseId, projectCount: certificateProjectIds.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error?.code === "23505") return { withdrawalRequestId, status: "existing" };
    throw error;
  } finally {
    client.release();
  }
}

async function createWithdrawalCases({ body, authUser, ip }) {
  requirePlainObject(body, "body");
  rejectUnexpectedFields(body, new Set(["items"]), "body");
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_BATCH_ITEMS) bad("items");
  const results = [];
  for (const raw of body.items) {
    try {
      requirePlainObject(raw, "items");
      rejectUnexpectedFields(raw, new Set(["withdrawalRequestId", "periodId", "certificateProjectIds"]), "items");
      results.push(await createOneWithdrawalCase({ item: raw, authUser, ip }));
    } catch (error) {
      if ([400, 404, 409].includes(error?.statusCode)) {
        results.push({
          withdrawalRequestId: typeof raw?.withdrawalRequestId === "string" ? raw.withdrawalRequestId : null,
          status: error.statusCode === 409 ? "conflict" : "invalid",
          message: error.message || "Input tidak valid."
        });
      } else {
        throw error;
      }
    }
  }
  return { items: results };
}

async function listEligible(rawQuery) {
  const activityType = requireActivityType(rawQuery.activityType);
  const periodId = rawQuery.periodId ? safeId(rawQuery.periodId, "periodId") : null;
  const search = optionalSearch(rawQuery.search);
  const limit = parseLimit(rawQuery.limit);
  const offset = parseOffset(rawQuery.offset);
  const params = [activityType];
  let periodParamIndex = null;
  const predicates = [
    "s.status = 'Alumni'",
    "s.tipe = $1"
  ];
  if (periodId) {
    params.push(periodId);
    periodParamIndex = params.length;
    predicates.push(`EXISTS (
      SELECT 1
      FROM student_periods sp_filter
      WHERE sp_filter.id = $${periodParamIndex}
        AND sp_filter.student_id = s.id
        AND sp_filter.tipe = $1
    )`);
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
             sp.id AS period_id,
             COALESCE(sp.tipe, s.tipe) AS period_activity_type,
             TO_CHAR(COALESCE(sp.mulai, pp.project_start_date, s.bergabung, gs.graduation_completed_at::date), 'YYYY-MM-DD') AS period_start_date,
             TO_CHAR(COALESCE(sp.selesai, pp.project_end_date, gs.graduation_completed_at::date), 'YYYY-MM-DD') AS period_end_date,
             COALESCE(sp.keterangan, pp.project_description, 'Periode dari relasi project mahasiswa') AS period_description,
             TO_CHAR(COALESCE(sp.selesai, pp.project_end_date, gs.graduation_completed_at::date, CURRENT_DATE), 'YYYY-MM-DD') AS completed_at,
             CASE
               WHEN sp.id IS NOT NULL THEN 'period:' || sp.id
               ELSE 'period:' || s.tipe || ':' ||
                    TO_CHAR(COALESCE(pp.project_start_date, s.bergabung, gs.graduation_completed_at::date), 'YYYY-MM-DD') || ':' ||
                    TO_CHAR(COALESCE(pp.project_end_date, gs.graduation_completed_at::date), 'YYYY-MM-DD')
             END AS period_key,
             COUNT(*) OVER() AS total_count
      FROM students s
      JOIN users u ON u.id = s.user_id
      JOIN graduation_submissions gs ON gs.student_id = s.id
      LEFT JOIN LATERAL (
        SELECT sp.*
        FROM student_periods sp
        WHERE sp.student_id = s.id
          AND sp.tipe = s.tipe
          ${periodId ? `AND sp.id = $${periodParamIndex}` : ""}
        ORDER BY sp.mulai DESC NULLS LAST, sp.id DESC
        LIMIT 1
      ) sp ON TRUE
      LEFT JOIN LATERAL (
        SELECT MIN(rm.bergabung) AS project_start_date,
               MAX(COALESCE(rm.selesai, gs.graduation_completed_at::date, CURRENT_DATE)) AS project_end_date,
               STRING_AGG(DISTINCT COALESCE(rp.short_title, rp.title, gsp.project_title, rm.project_id), ', ' ORDER BY COALESCE(rp.short_title, rp.title, gsp.project_title, rm.project_id)) AS project_description
        FROM research_memberships rm
        JOIN research_projects rp ON rp.id = rm.project_id
        LEFT JOIN graduation_submission_projects gsp
          ON gsp.student_id = s.id
         AND gsp.project_id = rm.project_id
        WHERE rm.user_id = s.user_id
          AND rm.member_type = 'Mahasiswa'
          AND (
            NOT EXISTS (SELECT 1 FROM graduation_submission_projects WHERE student_id = s.id)
            OR gsp.project_id IS NOT NULL
          )
      ) pp ON TRUE
      WHERE ${predicates.join(" AND ")}
        AND (sp.id IS NOT NULL OR pp.project_start_date IS NOT NULL OR pp.project_end_date IS NOT NULL OR s.bergabung IS NOT NULL OR gs.graduation_completed_at IS NOT NULL)
      ORDER BY u.name ASC, s.id ASC, sp.mulai DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    )
    SELECT f.*,
           c.id AS case_id, c.case_status, c.completion_document_id,
           COALESCE(projects.items, '[]'::jsonb) AS projects
    FROM filtered f
    LEFT JOIN dc_final_activity_cases c
      ON c.legacy_student_id = f.student_id
     AND c.period_key = f.period_key
     AND c.completion_document_definition_id = $${params.length + 1}
     AND c.outcome = 'completed'
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'id', rm.project_id,
        'title', rp.title,
        'shortTitle', rp.short_title,
        'role', rm.peran,
        'status', rp.status,
        'membershipStatus', rm.status,
        'joinedAt', TO_CHAR(rm.bergabung, 'YYYY-MM-DD'),
        'completedAt', TO_CHAR(rm.selesai, 'YYYY-MM-DD')
      ) ORDER BY COALESCE(rp.short_title, rp.title), rp.id) AS items
      FROM students ps
      JOIN research_memberships rm ON rm.user_id = ps.user_id AND rm.member_type = 'Mahasiswa'
      JOIN research_projects rp ON rp.id = rm.project_id
      LEFT JOIN graduation_submission_projects gsp ON gsp.student_id = ps.id AND gsp.project_id = rm.project_id
      WHERE ps.id = f.student_id
        AND (
          NOT EXISTS (SELECT 1 FROM graduation_submission_projects WHERE student_id = ps.id)
          OR gsp.project_id IS NOT NULL
        )
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
  const userRole = String(authUser?.role || "").toLowerCase() === "mahasiswa" ? "Mahasiswa" : "Operator";
  await client.query(
    `INSERT INTO audit_logs (id, user_id, user_role, action, target, ip, detail)
     VALUES ($1, $2, $3, 'Create', $4, $5, $6::jsonb)`,
    [
      `AUD-DC-${crypto.randomUUID()}`,
      requireSafeId(authUser?.id, "userId"),
      userRole,
      target,
      ip || null,
      JSON.stringify({ module: "document_center", event, ...detail })
    ]
  );
}

async function createOneCase({ item, authUser, ip, allowProjectPeriodFallback = false }) {
  const studentId = safeId(item.studentId, "studentId");
  const periodId = item.periodId || null;
  const primaryProjectId = item.primaryProjectId || null;
  if (periodId) safeId(periodId, "periodId");
  if (primaryProjectId) safeId(primaryProjectId, "primaryProjectId");
  if (!periodId && !allowProjectPeriodFallback) bad("periodId");
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
    let orderedProjects = projects;
    if (context.period_activity_type === "Magang" && projects.length > 1) {
      if (!primaryProjectId) {
        await client.query("ROLLBACK");
        return { studentId, periodId, status: "invalid", message: "Pilih project utama Magang." };
      }
      const primaryProject = projects.find((project) => String(project.project_id) === String(primaryProjectId));
      if (!primaryProject) {
        await client.query("ROLLBACK");
        return { studentId, periodId, status: "invalid", message: "Project utama Magang tidak valid untuk mahasiswa ini." };
      }
      orderedProjects = [
        primaryProject,
        ...projects.filter((project) => String(project.project_id) !== String(primaryProjectId))
      ];
    }
    const studentKey = buildStudentKey(context.student_id);
    const periodKey = context.period_id
      ? `period:${context.period_id}`
      : `period:${context.period_activity_type}:${context.period_start_date}:${context.period_end_date}`;
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
        context.period_id || null,
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
    for (let index = 0; index < orderedProjects.length; index += 1) {
      const project = orderedProjects[index];
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
      detail: {
        caseId,
        studentId: context.student_id,
        periodId: context.period_id,
        outcome: "completed",
        projectCount: projects.length,
        primaryProjectId: primaryProjectId || projects[0]?.project_id || null
      }
    });
    await client.query("COMMIT");
    return { studentId, periodId, status: "created", caseId, projectCount: projects.length, primaryProjectId: primaryProjectId || projects[0]?.project_id || null };
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
      rejectUnexpectedFields(raw, new Set(["studentId", "periodId", "primaryProjectId"]), "items");
      const caseResult = await createOneCase({
        item: { studentId: raw.studentId, periodId: raw.periodId, primaryProjectId: raw.primaryProjectId },
        authUser,
        ip,
        allowProjectPeriodFallback: true
      });
      if (["created", "existing"].includes(caseResult.status) && caseResult.caseId) {
        const drafts = await generateDraftsForCase({ caseId: caseResult.caseId, authUser, ip });
        results.push({ ...caseResult, ...drafts });
      } else {
        results.push(caseResult);
      }
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

async function generateDraftsForCase({ caseId, authUser, ip }) {
  let currentCase = await detailCase(caseId);
  let completionDraft = currentCase.completionDocument
    ? { status: "existing", documentId: currentCase.completionDocument.id }
    : { status: "not_applicable" };

  if (
    currentCase.activityType === "Magang" &&
    currentCase.outcome === "completed" &&
    currentCase.status === "pending" &&
    !currentCase.completionDocument &&
    (currentCase.projects || []).length > 0
  ) {
    try {
      const generated = await generateCompletionLetterDraft({ id: caseId, body: {}, authUser, ip });
      completionDraft = {
        status: "created",
        documentId: generated?.document?.id || null
      };
      currentCase = await detailCase(caseId);
    } catch (error) {
      if (error?.statusCode === 409) {
        completionDraft = {
          status: "skipped",
          message: error.message || "Surat Keterangan Selesai tidak dapat dibuat."
        };
      } else {
        throw error;
      }
    }
  }

  const certificateDrafts = [];
  for (const project of currentCase.projects || []) {
    if (!project.certificateRequired || project.certificateDocument || project.certificateStatus !== "pending") {
      certificateDrafts.push({
        caseProjectId: project.id,
        status: project.certificateDocument ? "existing" : project.certificateStatus
      });
      continue;
    }

    try {
      const generated = await generateCertificateDraft({ id: project.id, authUser, ip });
      certificateDrafts.push({
        caseProjectId: project.id,
        status: "created",
        documentId: generated?.document?.id || null
      });
    } catch (error) {
      if (error?.statusCode === 409) {
        certificateDrafts.push({
          caseProjectId: project.id,
          status: "skipped",
          message: error.message || "Sertifikat tidak dapat dibuat."
        });
      } else {
        throw error;
      }
    }
  }

  return { completionDraft, certificateDrafts };
}

async function cleanupCreatedFinalActivityCases({ caseIds }) {
  const safeCaseIds = [...new Set((caseIds || []).map((id) => safeId(id, "caseIds")))];
  if (!safeCaseIds.length) return { caseIds: [], documentIds: [] };

  const client = await pool.connect();
  const generatedFiles = [];
  try {
    await client.query("BEGIN");
    const lockedCases = await client.query(
      `
      SELECT id, completion_document_id
      FROM dc_final_activity_cases
      WHERE id = ANY($1::text[])
      FOR UPDATE
      `,
      [safeCaseIds]
    );
    const existingCaseIds = lockedCases.rows.map((row) => row.id);
    if (!existingCaseIds.length) {
      await client.query("COMMIT");
      return { caseIds: [], documentIds: [] };
    }

    const projectRows = await client.query(
      `
      SELECT id, certificate_document_id
      FROM dc_final_activity_case_projects
      WHERE final_activity_case_id = ANY($1::text[])
      FOR UPDATE
      `,
      [existingCaseIds]
    );

    const referencedDocumentIds = [
      ...lockedCases.rows.map((row) => row.completion_document_id).filter(Boolean),
      ...projectRows.rows.map((row) => row.certificate_document_id).filter(Boolean)
    ];
    const documentIds = [...new Set(referencedDocumentIds)];

    if (documentIds.length) {
      const documents = await client.query(
        `
        SELECT id, status
        FROM dc_official_documents
        WHERE id = ANY($1::text[])
        FOR UPDATE
        `,
        [documentIds]
      );
      const nonDraft = documents.rows.filter((row) => row.status !== "draft");
      if (nonDraft.length) {
        throw httpError(409, "Dokumen sudah berubah status dan tidak dapat dibersihkan otomatis.");
      }

      const versions = await client.query(
        `
        SELECT document_id, version_number
        FROM dc_document_versions
        WHERE document_id = ANY($1::text[])
        `,
        [documentIds]
      );
      for (const row of versions.rows) {
        generatedFiles.push(buildVersionFilePath(row.document_id, row.version_number));
      }
    }

    await client.query(
      `DELETE FROM dc_final_activity_case_projects WHERE final_activity_case_id = ANY($1::text[])`,
      [existingCaseIds]
    );
    await client.query(
      `DELETE FROM dc_final_activity_cases WHERE id = ANY($1::text[])`,
      [existingCaseIds]
    );

    if (documentIds.length) {
      await client.query(`DELETE FROM dc_official_document_students WHERE document_id = ANY($1::text[])`, [documentIds]);
      await client.query(`DELETE FROM dc_document_versions WHERE document_id = ANY($1::text[])`, [documentIds]);
      await client.query(`DELETE FROM dc_official_documents WHERE id = ANY($1::text[])`, [documentIds]);
    }

    await client.query("COMMIT");

    for (const filePath of generatedFiles) await fs.unlink(filePath).catch(() => {});
    return { caseIds: existingCaseIds, documentIds };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function createArtifactsForFinalizedAlumni({ studentId, authUser, ip }) {
  const safeStudentId = safeId(studentId, "studentId");
  const caseResult = await createOneCase({
    item: { studentId: safeStudentId },
    authUser,
    ip,
    allowProjectPeriodFallback: true
  });

  if (!["created", "existing"].includes(caseResult.status) || !caseResult.caseId) {
    return {
      status: caseResult.status,
      caseId: caseResult.caseId || null,
      completionDraft: { status: "not_created" },
      certificateDrafts: [],
      message: caseResult.message || null
    };
  }

  const drafts = await generateDraftsForCase({ caseId: caseResult.caseId, authUser, ip });

  return {
    status: caseResult.status,
    caseId: caseResult.caseId,
    ...drafts
  };
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
    SELECT f.total_count, rows.*,
           COALESCE(project_counts.certificate_count, 0) AS certificate_count
    FROM filtered f
    JOIN LATERAL (${CASE_SELECT} WHERE c.id = f.id) rows ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS certificate_count,
             COALESCE(
               jsonb_agg(
                 jsonb_build_object(
                   'id', cp.id,
                   'status', cp.certificate_status,
                   'documentNumber', od.document_number,
                   'documentStatus', od.status,
                   'documentId', od.id
                 )
                 ORDER BY cp.display_order, cp.id
               ) FILTER (WHERE cp.certificate_required = TRUE),
               '[]'::jsonb
             ) AS certificate_summary
      FROM dc_final_activity_case_projects cp
      LEFT JOIN dc_official_documents od ON od.id = cp.certificate_document_id
      WHERE cp.final_activity_case_id = f.id
        AND cp.certificate_required = TRUE
    ) project_counts ON TRUE
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
  const caseRow = await pool.query("SELECT legacy_student_id, outcome, completion_document_definition_id FROM dc_final_activity_cases WHERE id=$1 LIMIT 1", [caseId]);
  if (!caseRow.rowCount) throw httpError(404, "Case tidak ditemukan.");
  const caseDefinitionId = caseRow.rows[0].completion_document_definition_id;
  const outcome = caseRow.rows[0].outcome;
  const { generatedFrom } = definitionIdsForOutcome(outcome);
  const result = await createDocumentCenterDraft({
    authUser,
    ip,
    generatedFrom,
    body: {
      documentDefinitionId: caseDefinitionId,
      title: parsed.title || `Surat Keterangan Selesai - ${current.student.name || current.id}`,
      activityOutcome: outcome,
      fileName: parsed.fileName,
      fileDataUrl: parsed.fileDataUrl,
      participants: [{
        legacyStudentId: caseRow.rows[0].legacy_student_id,
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
      await insertAudit(client, { authUser: { id: operatorUserId }, ip, event: "final_activity_completion_draft_created", target: "document_center_final_activity", detail: { caseId, documentId, outcome } });
    }
  });
  return { document: result, case: await detailCase(caseId) };
}

async function uploadCertificateDraft({ id, body, authUser, ip }) {
  const parsed = parseDraftBody(body);
  const projectRowId = safeId(id, "id");
  const row = await pool.query(
    `SELECT cp.*, c.legacy_student_id, c.activity_type, c.period_snapshot, c.case_status,
            c.student_snapshot, c.outcome
     FROM dc_final_activity_case_projects cp
     JOIN dc_final_activity_cases c ON c.id = cp.final_activity_case_id
     WHERE cp.id=$1 LIMIT 1`,
    [projectRowId]
  );
  if (!row.rowCount) throw httpError(404, "Project case tidak ditemukan.");
  const project = row.rows[0];
  if (project.certificate_status !== "pending" || project.certificate_document_id || project.case_status === "revoked") throw httpError(409, "Sertifikat tidak dapat dibuatkan draft.");
  if (!project.certificate_document_definition_id) throw httpError(409, "Sertifikat tidak dapat dibuatkan draft.");
  const period = project.period_snapshot;
  const { generatedFrom } = definitionIdsForOutcome(project.outcome);
  const result = await createDocumentCenterDraft({
    authUser,
    ip,
    generatedFrom,
    body: {
      documentDefinitionId: project.certificate_document_definition_id,
      title: parsed.title || `Sertifikat - ${project.student_snapshot?.name || project.legacy_student_id}`,
      activityOutcome: project.outcome,
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
      await insertAudit(client, { authUser: { id: operatorUserId }, ip, event: "final_activity_certificate_draft_created", target: "document_center_final_activity", detail: { caseProjectId: projectRowId, caseId: project.final_activity_case_id, documentId, outcome: project.outcome } });
    }
  });
  return { document: result, case: await detailCase(project.final_activity_case_id) };
}

function optionalText(value, field, maxLength = 200) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") bad(field);
  const normalized = value.trim();
  if (normalized.length > maxLength || /[\x00-\x1F\x7F]/.test(normalized)) bad(field);
  return normalized || null;
}

function optionalDateText(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) bad(field);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || value !== date.toISOString().slice(0, 10)) bad(field);
  return value;
}

function parseCorrectionBody(body) {
  const payload = requirePlainObject(body, "body");
  rejectUnexpectedFields(payload, new Set(["student", "period", "projects"]), "body");

  const parsed = { student: {}, period: {}, projects: [] };
  if (payload.student !== undefined) {
    const student = requirePlainObject(payload.student, "student");
    rejectUnexpectedFields(student, new Set(["name", "nim", "prodi"]), "student");
    parsed.student.name = optionalText(student.name, "student.name", 160);
    parsed.student.nim = optionalText(student.nim, "student.nim", 60);
    parsed.student.prodi = optionalText(student.prodi, "student.prodi", 160);
  }
  if (payload.period !== undefined) {
    const period = requirePlainObject(payload.period, "period");
    rejectUnexpectedFields(period, new Set(["startDate", "endDate", "description"]), "period");
    parsed.period.startDate = optionalDateText(period.startDate, "period.startDate");
    parsed.period.endDate = optionalDateText(period.endDate, "period.endDate");
    parsed.period.description = optionalText(period.description, "period.description", 240);
    if (parsed.period.startDate && parsed.period.endDate && parsed.period.startDate > parsed.period.endDate) bad("period.endDate");
  }
  if (payload.projects !== undefined) {
    if (!Array.isArray(payload.projects) || payload.projects.length > 20) bad("projects");
    parsed.projects = payload.projects.map((item, index) => {
      const project = requirePlainObject(item, `projects.${index}`);
      rejectUnexpectedFields(project, new Set(["id", "title", "role", "joinedAt", "completedAt"]), `projects.${index}`);
      const joinedAt = optionalDateText(project.joinedAt, `projects.${index}.joinedAt`);
      const completedAt = optionalDateText(project.completedAt, `projects.${index}.completedAt`);
      if (joinedAt && completedAt && joinedAt > completedAt) bad(`projects.${index}.completedAt`);
      return {
        id: safeId(project.id, `projects.${index}.id`),
        title: optionalText(project.title, `projects.${index}.title`, 240),
        role: optionalText(project.role, `projects.${index}.role`, 160),
        joinedAt,
        completedAt
      };
    });
  }
  if (
    !Object.values(parsed.student).some((value) => value !== undefined) &&
    !Object.values(parsed.period).some((value) => value !== undefined) &&
    !parsed.projects.some((project) => Object.entries(project).some(([key, value]) => key !== "id" && value !== undefined))
  ) {
    bad("body");
  }
  return parsed;
}

function applyDefined(target, updates, mapping = {}) {
  const next = { ...(target || {}) };
  for (const [key, value] of Object.entries(updates || {})) {
    if (value !== undefined) next[mapping[key] || key] = value;
  }
  return next;
}

function projectPeriodSnapshot(caseRow, projectRow) {
  const project = projectRow?.project_snapshot || {};
  return {
    ...(caseRow.period_snapshot || {}),
    startDate: project.joinedAt || caseRow.period_snapshot?.startDate || null,
    endDate: project.completedAt || caseRow.period_snapshot?.endDate || null,
    description: project.shortTitle || project.title || caseRow.period_snapshot?.description || null
  };
}

async function loadDocumentForRegenerate(client, documentId) {
  const result = await client.query(
    `SELECT od.*, od.document_definition_id AS definition_id,
            dv.id AS version_id, dv.original_filename, dv.template_version_id,
            dv.signer_snapshot, dv.snapshot_data AS version_snapshot_data
     FROM dc_official_documents od
     JOIN dc_document_versions dv
       ON dv.document_id = od.id
      AND dv.version_number = od.current_version_number
     WHERE od.id=$1
     FOR UPDATE OF od`,
    [documentId]
  );
  if (!result.rowCount) throw httpError(409, "Dokumen belum memiliki versi aktif.");
  return result.rows[0];
}

async function insertRegeneratedVersion(client, { document, generated, reason }) {
  const nextVersionNumber = Number(document.current_version_number) + 1;
  const stagingPath = buildStagingFilePath(`${crypto.randomUUID()}.pdf`);
  const finalStorageKey = buildVersionStorageKey(document.id, nextVersionNumber);
  const finalPath = buildVersionFilePath(document.id, nextVersionNumber);
  let stagingWritten = false;
  try {
    await fs.mkdir(STAGING_ROOT, { recursive: true });
    await fs.writeFile(stagingPath, generated.pdfBuffer, { flag: "wx" });
    stagingWritten = true;
    await client.query(
      `INSERT INTO dc_document_versions (
         id, document_id, version_number, storage_key, original_filename,
         download_filename, mime_type, file_size, checksum_sha256,
         signer_snapshot, snapshot_data, version_reason, template_version_id
       ) VALUES ($1,$2,$3,$4,$5,$6,'application/pdf',$7,$8,$9::jsonb,$10::jsonb,$11,$12)`,
      [
        `DCVER-${crypto.randomUUID()}`,
        document.id,
        nextVersionNumber,
        finalStorageKey,
        document.original_filename || `${document.id}-corrected.pdf`,
        `${document.id}-v${nextVersionNumber}.pdf`,
        generated.pdfBuffer.length,
        crypto.createHash("sha256").update(generated.pdfBuffer).digest("hex"),
        JSON.stringify(generated.signer),
        JSON.stringify(generated.snapshotData),
        reason,
        generated.templateVersionId
      ]
    );
    await client.query(
      `UPDATE dc_official_documents
       SET current_version_number=$2, updated_at=NOW()
       WHERE id=$1`,
      [document.id, nextVersionNumber]
    );
    await fs.mkdir(getVersionDirectory(document.id), { recursive: true });
    await fs.rename(stagingPath, finalPath);
    stagingWritten = false;
    return { versionNumber: nextVersionNumber, finalPath };
  } catch (error) {
    if (stagingWritten) await fs.unlink(stagingPath).catch(() => {});
    throw error;
  }
}

async function regenerateCompletionDocument(client, { caseRow, projectRows }) {
  if (!caseRow.completion_document_id) return null;
  const document = await loadDocumentForRegenerate(client, caseRow.completion_document_id);
  if (document.status === "dicabut") return null;
  const primaryProject = projectRows[0];
  const primaryPeriod = projectPeriodSnapshot(caseRow, primaryProject);
  const letterData = buildLetterData({
    studentSnapshot: caseRow.student_snapshot,
    periodSnapshot: primaryPeriod,
    projectSnapshot: primaryProject?.project_snapshot || {}
  });
  const snapshot = {
    ...(document.version_snapshot_data || {}),
    student: caseRow.student_snapshot,
    period: primaryPeriod,
    project: primaryProject?.project_snapshot || null,
    projects: projectRows.map((row) => row.project_snapshot),
    letterData
  };
  let generated;
  try {
    generated = await renderPublishedCompletionLetterVersion({
      client,
      document: { ...document, version_snapshot_data: snapshot },
      documentNumber: document.document_number,
      issuedAt: document.issued_at
    });
  } catch (error) {
    if (error?.statusCode) throw error;
    throw httpError(409, `Render SKS gagal: ${error?.message || "template tidak dapat diproses."}`);
  }
  if (!generated) throw httpError(409, "Dokumen SKS tidak dapat diperbarui.");
  try {
    return { documentId: document.id, ...(await insertRegeneratedVersion(client, { document, generated, reason: "regenerate" })) };
  } catch (error) {
    if (error?.statusCode) throw error;
    throw httpError(409, `Simpan versi SKS gagal: ${error?.message || "file tidak dapat disimpan."}`);
  }
}

async function regenerateCertificateDocument(client, { caseRow, projectRow }) {
  if (!projectRow.certificate_document_id) return null;
  const document = await loadDocumentForRegenerate(client, projectRow.certificate_document_id);
  if (document.status === "dicabut") return null;
  const certificateCaseRow = { ...caseRow, period_snapshot: projectPeriodSnapshot(caseRow, projectRow) };
  const certificateData = buildCertificateData(certificateCaseRow, projectRow);
  const snapshot = {
    ...(document.version_snapshot_data || {}),
    student: caseRow.student_snapshot,
    period: certificateCaseRow.period_snapshot,
    project: projectRow.project_snapshot,
    certificateData
  };
  let generated;
  try {
    generated = await renderPublishedCertificateVersion({
      client,
      document: { ...document, version_snapshot_data: snapshot },
      documentNumber: document.document_number,
      issuedAt: document.issued_at
    });
  } catch (error) {
    if (error?.statusCode) throw error;
    throw httpError(409, `Render sertifikat gagal: ${error?.message || "template tidak dapat diproses."}`);
  }
  if (!generated) throw httpError(409, "Sertifikat tidak dapat diperbarui.");
  try {
    return { documentId: document.id, ...(await insertRegeneratedVersion(client, { document, generated, reason: "regenerate" })) };
  } catch (error) {
    if (error?.statusCode) throw error;
    throw httpError(409, `Simpan versi sertifikat gagal: ${error?.message || "file tidak dapat disimpan."}`);
  }
}

async function updateFinalActivityDynamicData({ id, body, authUser, ip }) {
  const caseId = safeId(id, "id");
  const operatorUserId = requireSafeId(authUser?.id, "userId");
  const parsed = parseCorrectionBody(body);
  const client = await pool.connect();
  const generatedFiles = [];
  try {
    await client.query("BEGIN");
    const caseResult = await client.query("SELECT * FROM dc_final_activity_cases WHERE id=$1 FOR UPDATE", [caseId]);
    if (!caseResult.rowCount) throw httpError(404, "Case tidak ditemukan.");
    let caseRow = caseResult.rows[0];
    if (!["draft_created", "issued"].includes(caseRow.case_status)) throw httpError(409, "Data dokumen belum dapat diperbarui.");

    const projectResult = await client.query(
      "SELECT * FROM dc_final_activity_case_projects WHERE final_activity_case_id=$1 ORDER BY display_order, id FOR UPDATE",
      [caseId]
    );
    if (!projectResult.rowCount) throw httpError(409, "Case belum memiliki project.");
    let projectRows = projectResult.rows;

    const nextStudent = applyDefined(caseRow.student_snapshot, parsed.student);
    const nextPeriod = applyDefined(caseRow.period_snapshot, parsed.period);
    await client.query(
      `UPDATE dc_final_activity_cases
       SET student_snapshot=$2::jsonb, period_snapshot=$3::jsonb, updated_at=NOW()
       WHERE id=$1`,
      [caseId, JSON.stringify(nextStudent), JSON.stringify(nextPeriod)]
    );
    caseRow = { ...caseRow, student_snapshot: nextStudent, period_snapshot: nextPeriod };

    for (const update of parsed.projects) {
      const current = projectRows.find((row) => row.id === update.id);
      if (!current) throw httpError(404, "Project case tidak ditemukan.", "projects.id");
      const nextProjectSnapshot = applyDefined(
        current.project_snapshot,
        update,
        { title: "title", role: "role", joinedAt: "joinedAt", completedAt: "completedAt" }
      );
      await client.query(
        `UPDATE dc_final_activity_case_projects
         SET project_snapshot=$2::jsonb, updated_at=NOW()
         WHERE id=$1`,
        [update.id, JSON.stringify(nextProjectSnapshot)]
      );
      projectRows = projectRows.map((row) => row.id === update.id ? { ...row, project_snapshot: nextProjectSnapshot } : row);
    }

    const completion = await regenerateCompletionDocument(client, { caseRow, projectRows });
    if (completion?.finalPath) generatedFiles.push(completion.finalPath);
    const certificates = [];
    for (const projectRow of projectRows) {
      const certificate = await regenerateCertificateDocument(client, { caseRow, projectRow });
      if (certificate?.finalPath) generatedFiles.push(certificate.finalPath);
      if (certificate) certificates.push(certificate);
    }

    const participantUpdates = [
      completion?.documentId,
      ...certificates.map((item) => item.documentId)
    ].filter(Boolean);
    for (const documentId of participantUpdates) {
      const project = projectRows.find((row) => row.certificate_document_id === documentId) || projectRows[0];
      const participantPeriod = projectPeriodSnapshot(caseRow, project);
      await client.query(
        `UPDATE dc_official_document_students
         SET name_snapshot=$2,
             nim_snapshot=$3,
             prodi_snapshot=$4,
             project_name_snapshot=$5,
             period_snapshot=$6,
             participant_role=$7
         WHERE document_id=$1`,
        [
          documentId,
          caseRow.student_snapshot?.name || null,
          caseRow.student_snapshot?.nim || null,
          caseRow.student_snapshot?.prodi || null,
          project?.project_snapshot?.title || null,
          periodText(participantPeriod),
          project?.project_snapshot?.role || "Peserta"
        ]
      );
    }

    await insertAudit(client, {
      authUser: { id: operatorUserId },
      ip,
      event: "final_activity_document_dynamic_data_updated",
      target: "document_center_final_activity",
      detail: {
        caseId,
        completionDocumentId: caseRow.completion_document_id || null,
        certificateDocumentIds: certificates.map((item) => item.documentId),
        projectIds: parsed.projects.map((item) => item.id)
      }
    });
    await client.query("COMMIT");
    return {
      case: await detailCase(caseId),
      regenerated: {
        completionDocument: completion ? { id: completion.documentId, versionNumber: completion.versionNumber } : null,
        certificateDocuments: certificates.map((item) => ({ id: item.documentId, versionNumber: item.versionNumber }))
      }
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    for (const file of generatedFiles) await fs.unlink(file).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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
  listWithdrawalEligible,
  createCases,
  createArtifactsForFinalizedAlumni,
  createWithdrawalCases,
  listCases,
  detailCase,
  uploadCompletionDraft,
  uploadCertificateDraft,
  updateFinalActivityDynamicData,
  cleanupCreatedFinalActivityCases,
  markIssuedForPublishedDocument
};
