const express = require("express");
const crypto = require("crypto");
const asyncHandler = require("../../utils/asyncHandler");
const { pool, query } = require("../../db/pool");
const { extractRole } = require("../../utils/roleGuard");
const {
  ensureResearchBoardTables,
  fetchBoardSnapshot,
  fetchProjectSprints,
  fetchTaskDetail,
  getNextTaskSortOrder,
  normalizeBoardTaskStatus,
  removeBoardAttachmentFile,
  saveBoardAttachmentFile,
  setTaskAssignees,
  upsertSprintTaskAssignment
} = require("../../utils/researchBoardStore");
const { createNotification } = require("../../utils/notificationService");
const { requireSafeId } = require("../../utils/securityValidation");

const router = express.Router();
let ensureResearchAttachmentLinkPromise = null;
let ensureResearchMembershipPeriodPromise = null;
let ensureResearchDocumentFieldsPromise = null;

let ensureJoinRequestsPromise = null;
async function ensureResearchJoinRequestsTable() {
  if (!ensureJoinRequestsPromise) {
    ensureJoinRequestsPromise = query(`
      CREATE TABLE IF NOT EXISTS research_join_requests (
        id SERIAL PRIMARY KEY,
        project_id TEXT REFERENCES research_projects(id) ON DELETE CASCADE,
        student_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        status TEXT DEFAULT 'Menunggu' CHECK (status IN ('Menunggu', 'Disetujui', 'Ditolak')),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE (project_id, student_id)
      );
      CREATE INDEX IF NOT EXISTS idx_research_join_requests_project ON research_join_requests(project_id);
      CREATE INDEX IF NOT EXISTS idx_research_join_requests_student ON research_join_requests(student_id);
    `).catch(err => {
      console.error("[Research] Failed to ensure join_requests table:", err);
    });
  }
  return ensureJoinRequestsPromise;
}

async function ensureResearchAttachmentLinkColumn() {
  if (!ensureResearchAttachmentLinkPromise) {
    ensureResearchAttachmentLinkPromise = query(`
      ALTER TABLE research_projects
      ADD COLUMN IF NOT EXISTS attachment_link TEXT
    `).catch((error) => {
      ensureResearchAttachmentLinkPromise = null;
      throw error;
    });
  }

  await ensureResearchAttachmentLinkPromise;
}

async function ensureResearchMembershipPeriodColumn() {
  if (!ensureResearchMembershipPeriodPromise) {
    ensureResearchMembershipPeriodPromise = query(`
      ALTER TABLE research_memberships
      ADD COLUMN IF NOT EXISTS selesai DATE
    `).catch((error) => {
      ensureResearchMembershipPeriodPromise = null;
      throw error;
    });
  }

  await ensureResearchMembershipPeriodPromise;
}

async function ensureResearchDocumentFieldsColumns() {
  if (!ensureResearchDocumentFieldsPromise) {
    ensureResearchDocumentFieldsPromise = query(`
      ALTER TABLE research_projects
      ADD COLUMN IF NOT EXISTS research_type TEXT CHECK (research_type IN ('Internal', 'Eksternal')),
      ADD COLUMN IF NOT EXISTS agreement_type TEXT CHECK (agreement_type IN ('PKS', 'MoU', 'MoA')),
      ADD COLUMN IF NOT EXISTS agreement_start_date DATE,
      ADD COLUMN IF NOT EXISTS agreement_end_date DATE,
      ADD COLUMN IF NOT EXISTS agreement_file_url TEXT,
      ADD COLUMN IF NOT EXISTS proposal_file_url TEXT,
      ADD COLUMN IF NOT EXISTS rab_file_url TEXT
    `).catch((error) => {
      ensureResearchDocumentFieldsPromise = null;
      throw error;
    });
  }

  await ensureResearchDocumentFieldsPromise;
}

router.use(
  asyncHandler(async (req, res, next) => {
    await ensureResearchAttachmentLinkColumn();
    await ensureResearchMembershipPeriodColumn();
    await ensureResearchDocumentFieldsColumns();
    next();
  })
);

["id", "cardId", "taskId", "subtaskId", "attachmentId", "commentId", "userId", "milestoneId", "meetingId", "divisionId", "sprintId"].forEach((paramName) => {
  router.param(paramName, (req, res, next, value) => {
    try {
      req.params[paramName] = requireSafeId(value, paramName);
      next();
    } catch (error) {
      next(error);
    }
  });
});

function buildResearchListFilters({ search, status }, params) {
  const filters = [];
  const statusValue = String(status || "").trim();
  const searchValue = String(search || "").trim();

  if (statusValue) {
    params.push(statusValue);
    filters.push(`rp.status = $${params.length}`);
  }

  if (searchValue) {
    params.push(`%${searchValue}%`);
    filters.push(`(
      rp.title ILIKE $${params.length}
      OR rp.short_title ILIKE $${params.length}
      OR rp.mitra ILIKE $${params.length}
      OR rp.status ILIKE $${params.length}
      OR rp.category ILIKE $${params.length}
      OR u.name ILIKE $${params.length}
    )`);
  }

  return filters;
}

function appendWhere(baseFilters, extraFilters) {
  const filters = [...baseFilters, ...extraFilters];
  return filters.length ? `WHERE ${filters.join(" AND ")}` : "";
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function pickBodyValue(body, camelKey, snakeKey) {
  if (hasOwn(body, camelKey)) return body[camelKey];
  if (snakeKey && hasOwn(body, snakeKey)) return body[snakeKey];
  return undefined;
}

function normalizeOptionalText(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeOptionalEnum(value, allowedValues, label) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return null;
  if (!allowedValues.includes(normalized)) {
    const error = new Error(`${label} harus salah satu dari: ${allowedValues.join(", ")}.`);
    error.status = 400;
    throw error;
  }
  return normalized;
}

function normalizeOptionalDate(value, label) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const error = new Error(`${label} harus menggunakan format YYYY-MM-DD.`);
    error.status = 400;
    throw error;
  }
  return normalized;
}

function formatDateOnly(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

function withResearchDocumentFields(row) {
  if (!row) return row;

  const agreementStartDate = formatDateOnly(row.agreement_start_date);
  const agreementEndDate = formatDateOnly(row.agreement_end_date);

  return {
    ...row,
    research_type: row.research_type ?? null,
    researchType: row.research_type ?? null,
    agreement_type: row.agreement_type ?? null,
    agreementType: row.agreement_type ?? null,
    agreement_start_date: agreementStartDate,
    agreementStartDate,
    agreement_end_date: agreementEndDate,
    agreementEndDate,
    agreement_file_url: row.agreement_file_url ?? null,
    agreementFileUrl: row.agreement_file_url ?? null,
    proposal_file_url: row.proposal_file_url ?? null,
    proposalFileUrl: row.proposal_file_url ?? null,
    rab_file_url: row.rab_file_url ?? null,
    rabFileUrl: row.rab_file_url ?? null
  };
}

function normalizeResearchDocumentFields(body) {
  const fields = {
    researchType: normalizeOptionalEnum(
      pickBodyValue(body, "researchType", "research_type"),
      ["Internal", "Eksternal"],
      "Jenis riset"
    ),
    agreementType: normalizeOptionalEnum(
      pickBodyValue(body, "agreementType", "agreement_type"),
      ["PKS", "MoU", "MoA"],
      "Jenis PKS/MoU/MoA"
    ),
    agreementStartDate: normalizeOptionalDate(
      pickBodyValue(body, "agreementStartDate", "agreement_start_date"),
      "Tanggal mulai PKS/MoU/MoA"
    ),
    agreementEndDate: normalizeOptionalDate(
      pickBodyValue(body, "agreementEndDate", "agreement_end_date"),
      "Tanggal selesai PKS/MoU/MoA"
    ),
    agreementFileUrl: normalizeOptionalText(pickBodyValue(body, "agreementFileUrl", "agreement_file_url")),
    proposalFileUrl: normalizeOptionalText(pickBodyValue(body, "proposalFileUrl", "proposal_file_url")),
    rabFileUrl: normalizeOptionalText(pickBodyValue(body, "rabFileUrl", "rab_file_url"))
  };

  if (
    fields.agreementStartDate &&
    fields.agreementEndDate &&
    fields.agreementEndDate < fields.agreementStartDate
  ) {
    const error = new Error("Tanggal selesai PKS/MoU/MoA tidak boleh sebelum tanggal mulai.");
    error.status = 400;
    throw error;
  }

  return fields;
}

function resolveRequesterUserId(req) {
  return String(req?.authUser?.id || "").trim();
}

async function hasProjectAccess({ userId, role, projectId }) {
  if (!userId || !role) return false;
  if (role === "operator") return true;

  if (role === "dosen") {
    const result = await query(
      `
      SELECT 1
      FROM research_projects rp
      LEFT JOIN research_memberships rm ON rm.project_id = rp.id AND rm.user_id = $1 AND COALESCE(rm.status, 'Aktif') = 'Aktif' AND (rm.selesai IS NULL OR rm.selesai >= CURRENT_DATE)
      LEFT JOIN lecturers l ON l.id = rp.supervisor_lecturer_id AND l.user_id = $1
      WHERE rp.id = $2
        AND (rm.user_id IS NOT NULL OR l.user_id IS NOT NULL)
      LIMIT 1
      `,
      [userId, projectId]
    );
    return result.rowCount > 0;
  }

  // Mahasiswa (termasuk alumni dengan peran='Alumni') bisa akses riset mereka
  const result = await query(
    `
    SELECT 1
    FROM research_projects rp
    LEFT JOIN research_memberships rm ON rm.project_id = rp.id AND rm.user_id = $1
    LEFT JOIN board_access ba ON ba.project_id = rp.id AND ba.user_id = $1
    WHERE rp.id = $2
      AND (rm.user_id IS NOT NULL OR ba.user_id IS NOT NULL)
    LIMIT 1
    `,
    [userId, projectId]
  );
  return result.rowCount > 0;
}

function isBoardManagerRole(role) {
  return role === "operator" || role === "dosen";
}

function isAllowedBoardFillField(key) {
  return ["status", "progress", "sortOrder"].includes(key);
}

function getUnexpectedBoardFillFields(body) {
  return Object.keys(body || {}).filter((key) => !isAllowedBoardFillField(key));
}

function normalizeMemberType(value) {
  return String(value || "").trim().toLowerCase();
}

function isKetuaPeran(value) {
  return String(value || "").trim().toLowerCase().includes("ketua");
}

async function ensureSingleKetuaPerScope({ projectId, userIdToExclude, memberType, peran }) {
  if (!isKetuaPeran(peran)) return null;

  const normalizedMemberType = normalizeMemberType(memberType);
  const isMahasiswaKetua = normalizedMemberType === "mahasiswa";
  const existingKetua = await query(
    `
    SELECT user_id, peran, member_type
    FROM research_memberships
    WHERE project_id = $1
      AND LOWER(COALESCE(peran, '')) LIKE '%ketua%'
      AND LOWER(COALESCE(member_type, '')) ${isMahasiswaKetua ? "=" : "<>"} 'mahasiswa'
      ${userIdToExclude ? "AND user_id != $2" : ""}
    LIMIT 1
    `,
    userIdToExclude ? [projectId, userIdToExclude] : [projectId]
  );

  if (existingKetua.rowCount === 0) return null;

  return isMahasiswaKetua
    ? `Hanya boleh ada 1 Mahasiswa Ketua Riset per riset. Ketua saat ini: ${existingKetua.rows[0].peran}`
    : `Hanya boleh ada 1 Ketua Peneliti/Pembimbing per riset. Ketua saat ini: ${existingKetua.rows[0].peran}`;
}

async function isProjectLeaderMember({ userId, projectId }) {
  if (!userId || !projectId) return false;

  const result = await query(
    `
    SELECT 1
    FROM research_memberships
    WHERE project_id = $1
      AND user_id = $2
      AND LOWER(COALESCE(member_type, '')) = 'mahasiswa'
      AND LOWER(COALESCE(peran, '')) LIKE '%ketua%'
      AND COALESCE(status, 'Aktif') = 'Aktif'
      AND (selesai IS NULL OR selesai >= CURRENT_DATE)
    LIMIT 1
    `,
    [projectId, userId]
  );

  return result.rowCount > 0;
}

async function getBoardAccessContext({ req, projectId }) {
  const role = extractRole(req);
  const userId = resolveRequesterUserId(req);
  const hasAccess = await hasProjectAccess({ userId, role, projectId });
  const isLeaderMember =
    hasAccess && role === "mahasiswa"
      ? await isProjectLeaderMember({ userId, projectId })
      : false;

  return {
    role,
    userId,
    hasAccess,
    isLeaderMember,
    isManager: hasAccess && (isBoardManagerRole(role) || isLeaderMember),
    canFillExistingCards: hasAccess && (isBoardManagerRole(role) || role === "mahasiswa")
  };
}

function buildEntityId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function toNullableText(value) {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : null;
}

function createHttpError(message, statusCode, code = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function mapResearchDivision(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    project_id: row.project_id,
    name: row.name,
    sortOrder: Number(row.sort_order) || 0,
    sort_order: Number(row.sort_order) || 0,
    isActive: row.is_active === true,
    is_active: row.is_active === true,
    createdAt: row.created_at,
    created_at: row.created_at,
    updatedAt: row.updated_at,
    updated_at: row.updated_at
  };
}

function normalizeDivisionName(value) {
  const name = String(value || "").trim();
  if (!name) throw createHttpError("Nama divisi wajib diisi.", 400);
  if (name.length > 100) throw createHttpError("Nama divisi maksimal 100 karakter.", 400);
  return name;
}

function normalizeDivisionSortOrder(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw createHttpError("Urutan divisi harus berupa integer.", 400);
  return parsed;
}

async function validateProjectDivision({ projectId, divisionId, executor = query, allowInactive = false }) {
  if (!divisionId) return null;
  const run = typeof executor === "function" ? executor : executor.query.bind(executor);
  const result = await run(
    "SELECT id, project_id, name, sort_order, is_active, created_at, updated_at FROM research_divisions WHERE id = $1 LIMIT 1 FOR SHARE",
    [divisionId]
  );
  if (result.rowCount === 0) throw createHttpError("Divisi riset tidak ditemukan.", 404);
  const division = result.rows[0];
  if (division.project_id !== projectId) {
    throw createHttpError("Divisi harus berasal dari riset yang sama dengan task.", 400);
  }
  if (!allowInactive && division.is_active !== true) {
    throw createHttpError("Divisi nonaktif tidak dapat dipilih untuk task baru.", 409);
  }
  return division;
}

async function validateProjectSprint({ projectId, sprintId, executor = query, allowHistorical = false }) {
  if (!sprintId) return null;
  const run = typeof executor === "function" ? executor : executor.query.bind(executor);
  const result = await run(
    "SELECT id, project_id, status FROM research_sprints WHERE id = $1 LIMIT 1 FOR SHARE",
    [sprintId]
  );
  if (result.rowCount === 0) throw createHttpError("Sprint tidak ditemukan.", 404);
  if (result.rows[0].project_id !== projectId) {
    throw createHttpError("Sprint harus berasal dari riset yang sama dengan task.", 400);
  }
  if (!allowHistorical && ["review", "closed"].includes(result.rows[0].status)) {
    throw createHttpError("Task baru tidak dapat ditambahkan ke Sprint review atau closed.", 409);
  }
  return result.rows[0];
}

async function lockScrumProject(client, projectId) {
  const result = await client.query("SELECT id FROM research_projects WHERE id = $1 FOR UPDATE", [projectId]);
  if (result.rowCount === 0) throw createHttpError("Riset tidak ditemukan.", 404);
}

async function assertSprintCanActivate(client, projectId, sprintId) {
  const conflict = await client.query(
    `
    SELECT id, status
    FROM research_sprints
    WHERE project_id = $1
      AND id <> $2
      AND status IN ('active', 'review')
    ORDER BY CASE status WHEN 'review' THEN 1 ELSE 2 END
    LIMIT 1
    `,
    [projectId, sprintId]
  );
  if (conflict.rowCount === 0) return;
  if (conflict.rows[0].status === "review") {
    throw createHttpError(
      "Sprint sebelumnya masih menunggu Review/Summary dan harus difinalisasi terlebih dahulu.",
      409,
      "SCRUM_SPRINT_REVIEW_PENDING"
    );
  }
  throw createHttpError(
    "Riset ini sudah memiliki Sprint aktif.",
    409,
    "SCRUM_ACTIVE_SPRINT_EXISTS"
  );
}

function runResearchQuery(executor, text, params = []) {
  return typeof executor === "function" ? executor(text, params) : executor.query(text, params);
}

async function assertTaskCurrentSprintMutable({ projectId, taskId, executor = query }) {
  const result = await runResearchQuery(
    executor,
    `SELECT t.id, t.sprint_id, s.status AS sprint_status
     FROM research_board_tasks t
     LEFT JOIN research_sprints s ON s.id = t.sprint_id
     WHERE t.project_id = $1 AND t.id = $2`,
    [projectId, taskId]
  );
  if (result.rowCount === 0) throw createHttpError("Task board tidak ditemukan.", 404);
  if (["review", "closed"].includes(result.rows[0].sprint_status)) {
    throw createHttpError(
      "Task pada Sprint review atau closed bersifat read-only.",
      409,
      "SCRUM_SPRINT_READ_ONLY"
    );
  }
  return result.rows[0];
}

function mapSprintSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    sprintId: row.sprint_id,
    sprint_id: row.sprint_id,
    summary: row.summary || "",
    achievements: row.achievements || "",
    challenges: row.challenges || "",
    lessonsLearned: row.lessons_learned || "",
    lessons_learned: row.lessons_learned || "",
    nextSprintPlan: row.next_sprint_plan || "",
    next_sprint_plan: row.next_sprint_plan || "",
    isFinalized: row.is_finalized === true,
    is_finalized: row.is_finalized === true,
    createdBy: row.created_by,
    created_by: row.created_by,
    finalizedBy: row.finalized_by,
    finalized_by: row.finalized_by,
    createdAt: row.created_at,
    created_at: row.created_at,
    updatedAt: row.updated_at,
    updated_at: row.updated_at,
    finalizedAt: row.finalized_at,
    finalized_at: row.finalized_at
  };
}

function mapReviewMeeting(row, attendees = []) {
  if (!row) return null;
  return {
    id: row.id,
    sprintId: row.sprint_id,
    sprint_id: row.sprint_id,
    meetingDate: row.meeting_date,
    meeting_date: row.meeting_date,
    startTime: row.start_time,
    start_time: row.start_time,
    location: row.location || "",
    meetingLink: row.meeting_link || "",
    meeting_link: row.meeting_link || "",
    chairUserId: row.chair_user_id,
    chair_user_id: row.chair_user_id,
    agenda: row.agenda || "",
    notes: row.notes || "",
    decisions: row.decisions || "",
    createdBy: row.created_by,
    created_by: row.created_by,
    createdAt: row.created_at,
    created_at: row.created_at,
    updatedAt: row.updated_at,
    updated_at: row.updated_at,
    attendees
  };
}

function mapEvaluation(row) {
  if (!row) return null;
  return {
    id: row.id,
    sprintId: row.sprint_id,
    sprint_id: row.sprint_id,
    evaluatedUserId: row.evaluated_user_id,
    evaluated_user_id: row.evaluated_user_id,
    taskCompletion: Number(row.task_completion),
    task_completion: Number(row.task_completion),
    quality: Number(row.quality),
    timeliness: Number(row.timeliness),
    collaboration: Number(row.collaboration),
    initiative: Number(row.initiative),
    overallScore: Number(row.overall_score),
    overall_score: Number(row.overall_score),
    notes: row.notes,
    createdBy: row.created_by,
    created_by: row.created_by,
    createdAt: row.created_at,
    created_at: row.created_at,
    updatedAt: row.updated_at,
    updated_at: row.updated_at
  };
}

async function getRequiredEvaluationMembers(projectId, sprintId, executor = query) {
  const result = await runResearchQuery(
    executor,
    `
    SELECT DISTINCT u.id, u.name, u.initials, u.role,
           COALESCE(rm.member_type, CASE WHEN u.role = 'mahasiswa' THEN 'Mahasiswa' ELSE 'Dosen' END) AS member_type,
           COALESCE(rm.peran, '') AS peran
    FROM users u
    LEFT JOIN research_memberships rm
      ON rm.project_id = $1 AND rm.user_id = u.id AND rm.status = 'Aktif'
    WHERE u.id IN (
      SELECT rm2.user_id FROM research_memberships rm2
      WHERE rm2.project_id = $1 AND rm2.status = 'Aktif'
      UNION
      SELECT DISTINCT ta.user_id
      FROM research_sprint_task_assignments a
      JOIN research_board_task_assignees ta ON ta.task_id = a.task_id
      WHERE a.sprint_id = $2
    )
    ORDER BY u.name ASC, u.id ASC
    `,
    [projectId, sprintId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    userId: row.id,
    user_id: row.id,
    name: row.name,
    initials: row.initials,
    role: row.role,
    memberType: row.member_type,
    member_type: row.member_type,
    peran: row.peran
  }));
}

async function loadSprintReviewState({ projectId, sprintId, executor = query }) {
  const sprintResult = await runResearchQuery(
    executor,
    "SELECT * FROM research_sprints WHERE project_id = $1 AND id = $2 LIMIT 1",
    [projectId, sprintId]
  );
  if (sprintResult.rowCount === 0) throw createHttpError("Sprint tidak ditemukan.", 404);

  // A transaction client can execute only one query at a time. Keep these
  // reads sequential so review/finalize requests never overlap client.query.
  const summaryResult = await runResearchQuery(executor, "SELECT * FROM research_sprint_summaries WHERE sprint_id = $1", [sprintId]);
  const meetingResult = await runResearchQuery(executor, "SELECT * FROM research_sprint_review_meetings WHERE sprint_id = $1", [sprintId]);
  const attendeeResult = await runResearchQuery(
    executor,
    `SELECT a.meeting_id, a.user_id, a.name_snapshot, a.role_snapshot
     FROM research_sprint_review_attendees a
     JOIN research_sprint_review_meetings m ON m.id = a.meeting_id
     WHERE m.sprint_id = $1 ORDER BY a.name_snapshot ASC`,
    [sprintId]
  );
  const evaluationResult = await runResearchQuery(executor, "SELECT * FROM research_sprint_member_evaluations WHERE sprint_id = $1 ORDER BY evaluated_user_id", [sprintId]);
  const ledgerResult = await runResearchQuery(
    executor,
    `
    SELECT a.*, t.title, t.status AS current_status, t.progress AS current_progress,
           t.cancelled_at, t.cancelled_by,
           ARRAY_REMOVE(ARRAY_AGG(DISTINCT ta.user_id), NULL) AS assignee_ids
    FROM research_sprint_task_assignments a
    JOIN research_board_tasks t ON t.id = a.task_id
    LEFT JOIN research_board_task_assignees ta ON ta.task_id = a.task_id
    WHERE a.sprint_id = $1
    GROUP BY a.id, t.id
    ORDER BY a.assigned_at ASC, a.task_id ASC
    `,
    [sprintId]
  );
  const requiredEvaluations = await getRequiredEvaluationMembers(projectId, sprintId, executor);
  const attendeesByMeeting = new Map();
  for (const row of attendeeResult.rows) {
    if (!attendeesByMeeting.has(row.meeting_id)) attendeesByMeeting.set(row.meeting_id, []);
    attendeesByMeeting.get(row.meeting_id).push({
      userId: row.user_id,
      user_id: row.user_id,
      name: row.name_snapshot,
      nameSnapshot: row.name_snapshot,
      name_snapshot: row.name_snapshot,
      role: row.role_snapshot,
      roleSnapshot: row.role_snapshot,
      role_snapshot: row.role_snapshot
    });
  }
  const summary = mapSprintSummary(summaryResult.rows[0]);
  const meeting = mapReviewMeeting(meetingResult.rows[0], meetingResult.rows[0] ? attendeesByMeeting.get(meetingResult.rows[0].id) || [] : []);
  const evaluations = evaluationResult.rows.map(mapEvaluation);
  const evaluationIds = new Set(evaluations.map((row) => row.evaluatedUserId));
  const useClosedSnapshots = sprintResult.rows[0].status === "closed" || summary?.isFinalized === true;
  const ledgerRows = ledgerResult.rows.map((row) => {
    // Closed Sprint history is ledger-only. Legacy rows fall back conservatively
    // to assignment status and zero/non-DONE progress, never the Task's later state.
    const effectiveStatus = useClosedSnapshots
      ? (row.status_at_close || row.status_at_assignment)
      : (row.current_status || row.status_at_assignment);
    const effectiveProgress = useClosedSnapshots
      ? (row.progress_at_close ?? (String(row.status_at_assignment).toUpperCase() === "DONE" ? 100 : 0))
      : (row.current_progress ?? 0);
    return { ...row, effective_status: effectiveStatus, effective_progress: Number(effectiveProgress) || 0 };
  });
  const unfinishedRows = ledgerRows.filter((row) => String(row.effective_status).toUpperCase() !== "DONE");

  const divisionMap = new Map();
  for (const row of ledgerRows) {
    const key = row.division_id_at_assignment || "__unassigned__";
    if (!divisionMap.has(key)) {
      divisionMap.set(key, {
        divisionId: row.division_id_at_assignment || null,
        division_id: row.division_id_at_assignment || null,
        divisionName: row.division_name_at_assignment || "Belum Ada Divisi",
        division_name: row.division_name_at_assignment || "Belum Ada Divisi",
        totalTasks: 0,
        completedTasks: 0,
        unfinishedTasks: 0,
        plannedStoryPoints: 0,
        completedStoryPoints: 0
      });
    }
    const division = divisionMap.get(key);
    const isDone = String(row.effective_status).toUpperCase() === "DONE";
    division.totalTasks += 1;
    division.plannedStoryPoints += Number(row.story_points_at_assignment || 0);
    if (isDone) {
      division.completedTasks += 1;
      division.completedStoryPoints += Number(row.story_points_at_assignment || 0);
    } else {
      division.unfinishedTasks += 1;
    }
  }

  const memberMetrics = requiredEvaluations.map((member) => {
    const rows = ledgerRows.filter((row) => (row.assignee_ids || []).includes(member.id));
    const completed = rows.filter((row) => String(row.effective_status).toUpperCase() === "DONE");
    return {
      ...member,
      assignedTasks: rows.length,
      completedTasks: completed.length,
      plannedStoryPoints: rows.reduce((sum, row) => sum + Number(row.story_points_at_assignment || 0), 0),
      completedStoryPoints: completed.reduce((sum, row) => sum + Number(row.story_points_at_assignment || 0), 0),
      carryOverTasks: rows.filter((row) => row.outcome === "carry_over").length
    };
  });

  const finalizationErrors = [];
  if (sprintResult.rows[0].status !== "review") finalizationErrors.push({ code: "SPRINT_NOT_REVIEW", message: "Sprint harus berstatus review." });
  if (summaryResult.rows.length === 0 || !String(summaryResult.rows[0].summary || "").trim()) finalizationErrors.push({ code: "SUMMARY_REQUIRED", message: "Summary utama wajib diisi." });
  if (!meetingResult.rows[0]?.meeting_date) finalizationErrors.push({ code: "MEETING_DATE_REQUIRED", message: "Tanggal Review Meeting wajib diisi." });
  if (!String(meetingResult.rows[0]?.notes || "").trim() && !String(meetingResult.rows[0]?.decisions || "").trim()) finalizationErrors.push({ code: "MEETING_NOTES_REQUIRED", message: "Notes atau decisions Review Meeting wajib diisi." });
  for (const member of requiredEvaluations) {
    if (!evaluationIds.has(member.id)) finalizationErrors.push({ code: "EVALUATION_REQUIRED", userId: member.id, message: `Evaluasi untuk ${member.name} wajib diisi.` });
  }
  for (const row of unfinishedRows) {
    if (row.outcome === "pending") finalizationErrors.push({ code: "OUTCOME_REQUIRED", taskId: row.task_id, message: `Outcome untuk task ${row.title} wajib dipilih.` });
    if (row.outcome === "carry_over" && !row.target_sprint_id) finalizationErrors.push({ code: "CARRY_OVER_TARGET_REQUIRED", taskId: row.task_id, message: `Target Sprint untuk task ${row.title} wajib dipilih.` });
  }
  const carryTargets = [...new Set(unfinishedRows.filter((row) => row.outcome === "carry_over" && row.target_sprint_id).map((row) => row.target_sprint_id))];
  if (carryTargets.length > 0) {
    const targetResult = await runResearchQuery(
      executor,
      "SELECT id, status FROM research_sprints WHERE project_id = $1 AND id = ANY($2::text[])",
      [projectId, carryTargets]
    );
    const targetMap = new Map(targetResult.rows.map((row) => [row.id, row.status]));
    for (const targetId of carryTargets) {
      if (targetMap.get(targetId) !== "planning") finalizationErrors.push({ code: "INVALID_CARRY_OVER_TARGET", targetSprintId: targetId, message: "Carry-over hanya dapat menuju Sprint planning pada project yang sama." });
    }
  }
  if (summaryResult.rows[0]?.is_finalized) finalizationErrors.push({ code: "ALREADY_FINALIZED", message: "Sprint sudah difinalisasi." });

  const plannedStoryPoints = ledgerRows.reduce((sum, row) => sum + Number(row.story_points_at_assignment || 0), 0);
  const completedStoryPoints = ledgerRows.filter((row) => String(row.effective_status).toUpperCase() === "DONE").reduce((sum, row) => sum + Number(row.story_points_at_assignment || 0), 0);
  const totalTasks = ledgerRows.length;
  const completedTasks = ledgerRows.filter((row) => String(row.effective_status).toUpperCase() === "DONE").length;

  return {
    sprint: sprintResult.rows[0],
    summary,
    meeting,
    evaluations,
    requiredEvaluations,
    memberMetrics,
    ledgerRows,
    unfinishedRows,
    divisionResults: [...divisionMap.values()],
    overview: {
      plannedStoryPoints,
      completedStoryPoints,
      totalTasks,
      completedTasks,
      unfinishedTasks: totalTasks - completedTasks,
      completionPercentage: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 10000) / 100 : 0
    },
    finalizationErrors,
    canFinalize: finalizationErrors.length === 0
  };
}

function mapSummaryResponse(state) {
  const unfinishedWork = state.unfinishedRows.map((row) => ({
    taskId: row.task_id,
    task_id: row.task_id,
    title: row.title,
    status: row.effective_status,
    progress: row.effective_progress,
    divisionId: row.division_id_at_assignment || null,
    divisionName: row.division_name_at_assignment || "Belum Ada Divisi",
    storyPoints: Number(row.story_points_at_assignment || 0),
    outcome: row.outcome,
    targetSprintId: row.target_sprint_id,
    target_sprint_id: row.target_sprint_id
  }));
  const completedWork = state.ledgerRows.filter((row) => String(row.effective_status).toUpperCase() === "DONE").map((row) => ({
    taskId: row.task_id,
    task_id: row.task_id,
    title: row.title,
    status: row.effective_status,
    divisionId: row.division_id_at_assignment || null,
    divisionName: row.division_name_at_assignment || "Belum Ada Divisi",
    storyPoints: Number(row.story_points_at_assignment || 0)
  }));
  return {
    sprint: state.sprint,
    overview: state.overview,
    divisionResults: state.divisionResults,
    completedWork,
    unfinishedWork,
    meeting: state.meeting,
    summary: state.summary,
    requiredEvaluations: state.requiredEvaluations,
    evaluations: state.evaluations,
    memberMetrics: state.memberMetrics,
    planningTargetSprints: [],
    canFinalize: state.canFinalize,
    finalizationErrors: state.finalizationErrors
  };
}

function rethrowSprintUniqueViolation(error) {
  if (error?.code === "23505" && String(error?.constraint || "").includes("one_active_per_project")) {
    throw createHttpError("Riset ini sudah memiliki Sprint aktif.", 409, "SCRUM_ACTIVE_SPRINT_EXISTS");
  }
  throw error;
}

function normalizeAssigneeIds(assigneeIds) {
  return Array.from(
    new Set(
      (Array.isArray(assigneeIds) ? assigneeIds : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
}

function normalizeProgress(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

async function ensureTaskExists(projectId, taskId) {
  await ensureResearchBoardTables();
  const result = await query(
    `
    SELECT id, project_id, status
    FROM research_board_tasks
    WHERE project_id = $1 AND id = $2
    LIMIT 1
    `,
    [projectId, taskId]
  );

  return result.rows[0] || null;
}

async function validateAssigneeIds(assigneeIds) {
  const normalizedIds = normalizeAssigneeIds(assigneeIds);
  if (normalizedIds.length === 0) return [];

  const result = await query("SELECT id FROM users WHERE id = ANY($1::text[])", [normalizedIds]);
  const existingIds = new Set(result.rows.map((row) => row.id));
  const missingIds = normalizedIds.filter((id) => !existingIds.has(id));

  if (missingIds.length > 0) {
    const error = new Error(`Assignee tidak ditemukan: ${missingIds.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }

  return normalizedIds;
}

async function notifyMilestoneUpdate(projectId, actorUserId, actionLabel, milestoneLabel) {
  const projectResult = await query(
    `
    SELECT id, COALESCE(short_title, title) AS project_name, supervisor_lecturer_id
    FROM research_projects
    WHERE id = $1
    LIMIT 1
    `,
    [projectId]
  );

  if (projectResult.rowCount === 0) return;

  const project = projectResult.rows[0];
  const recipientsResult = await query(
    `
    SELECT DISTINCT user_id
    FROM (
      SELECT rm.user_id
      FROM research_memberships rm
      WHERE rm.project_id = $1
        AND COALESCE(rm.status, 'Aktif') = 'Aktif'
        AND (rm.selesai IS NULL OR rm.selesai >= CURRENT_DATE)
      UNION
      SELECT l.user_id
      FROM lecturers l
      WHERE l.id = $2
    ) recipients
    WHERE user_id IS NOT NULL
      AND ($3::text IS NULL OR user_id <> $3)
    `,
    [projectId, project.supervisor_lecturer_id, actorUserId || null]
  );

  if (recipientsResult.rowCount === 0) return;

  await Promise.all(
    recipientsResult.rows.map((row) =>
      createNotification({
        recipientUserId: row.user_id,
        senderUserId: actorUserId || null,
        type: "milestone",
        eventId: "milestone_update",
        title: "Update Milestone Riset",
        body: `${actionLabel} milestone "${milestoneLabel}" pada riset ${project.project_name}.`
      })
    )
  );
}

router.get(
  "/assigned",
  asyncHandler(async (req, res) => {
    await ensureResearchJoinRequestsTable();
    const roleFromToken = extractRole(req);
    const queryUserId = String(req.query.userId || "");
    const requesterUserId = resolveRequesterUserId(req);
    const userId = roleFromToken === "operator" ? queryUserId : (requesterUserId || queryUserId);
    if (!userId) {
      return res.status(400).json({ message: "userId wajib diisi." });
    }

    const userRow = await query("SELECT role FROM users WHERE id = $1 LIMIT 1", [userId]);
    if (userRow.rowCount === 0) {
      return res.status(404).json({ message: "User tidak ditemukan." });
    }

    const role = userRow.rows[0].role;
    let result;

    if (role === "operator") {
      result = await query(
        `
        SELECT rp.id, rp.title, rp.short_title, rp.status, rp.progress, rp.period_text,
               rp.research_type, rp.agreement_type, rp.agreement_start_date, rp.agreement_end_date,
               rp.agreement_file_url, rp.proposal_file_url, rp.rab_file_url
        FROM research_projects rp
        ORDER BY rp.id ASC
        LIMIT 500
        `
      );
    } else if (role === "dosen") {
      result = await query(
        `
        SELECT DISTINCT rp.id, rp.title, rp.short_title, rp.status, rp.progress, rp.period_text,
               rp.research_type, rp.agreement_type, rp.agreement_start_date, rp.agreement_end_date,
               rp.agreement_file_url, rp.proposal_file_url, rp.rab_file_url
        FROM research_projects rp
        LEFT JOIN research_memberships rm
          ON rm.project_id = rp.id AND rm.user_id = $1 AND COALESCE(rm.status, 'Aktif') = 'Aktif' AND (rm.selesai IS NULL OR rm.selesai >= CURRENT_DATE)
        LEFT JOIN lecturers l
          ON l.id = rp.supervisor_lecturer_id AND l.user_id = $1
        WHERE rm.user_id IS NOT NULL OR l.user_id IS NOT NULL
        ORDER BY rp.id ASC
        LIMIT 500
        `,
        [userId]
      );
    } else {
      result = await query(
        `
        SELECT DISTINCT rp.id, rp.title, rp.short_title, rp.status, rp.progress, rp.period_text,
               rp.research_type, rp.agreement_type, rp.agreement_start_date, rp.agreement_end_date,
               rp.agreement_file_url, rp.proposal_file_url, rp.rab_file_url,
               rm.peran AS my_peran,
               rm.selesai AS my_selesai,
               rm.status AS membership_status,
               rjr.status AS join_request_status
        FROM research_projects rp
        JOIN research_memberships rm ON rm.project_id = rp.id
        LEFT JOIN research_join_requests rjr ON rjr.project_id = rp.id AND rjr.student_id = $1 AND rjr.status = 'Menunggu'
        WHERE rm.user_id = $1
          AND COALESCE(rm.status, 'Aktif') != 'Ditolak'
        ORDER BY rp.id ASC
        LIMIT 500
        `,
        [userId]
      );
    }

    res.json(result.rows.map(withResearchDocumentFields));
  })
);

router.get(
  "/my-scrum",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const userId = resolveRequesterUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Pengguna tidak terotentikasi." });
    }

    // Cari riset mahasiswa yang memiliki active sprint dan/atau task yang di-assign ke mahasiswa ini
    const result = await query(
      `
      SELECT DISTINCT rp.id, rp.title, rp.short_title,
             s.id AS active_sprint_id, s.name AS active_sprint_name, s.start_date, s.end_date,
             COUNT(t.id)::int AS my_tasks_count
      FROM research_projects rp
      JOIN research_memberships rm ON rm.project_id = rp.id AND rm.user_id = $1 AND COALESCE(rm.status, 'Aktif') = 'Aktif'
      LEFT JOIN research_sprints s ON s.project_id = rp.id AND s.status = 'active'
      LEFT JOIN research_board_tasks t ON t.project_id = rp.id AND (t.sprint_id = s.id OR s.id IS NULL)
      LEFT JOIN research_board_task_assignees a ON a.task_id = t.id AND a.user_id = $1
      WHERE s.id IS NOT NULL OR a.user_id IS NOT NULL
      GROUP BY rp.id, rp.title, rp.short_title, s.id, s.name, s.start_date, s.end_date
      LIMIT 10
      `,
      [userId]
    );

    const hasActiveScrum = result.rowCount > 0;
    const activeProject = result.rows[0] || null;

    res.json({
      hasActiveScrum,
      primaryProjectId: activeProject?.id || null,
      activeSprint: activeProject?.active_sprint_id ? {
        id: activeProject.active_sprint_id,
        name: activeProject.active_sprint_name,
        startDate: activeProject.start_date,
        endDate: activeProject.end_date,
        projectId: activeProject.id,
        projectTitle: activeProject.short_title || activeProject.title
      } : null,
      projects: result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        shortTitle: row.short_title,
        activeSprintId: row.active_sprint_id,
        activeSprintName: row.active_sprint_name,
        myTasksCount: Number(row.my_tasks_count) || 0
      }))
    });
  })
);

router.get(
  "/my-scrum-tasks",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const userId = resolveRequesterUserId(req);
    if (!userId) {
      return res.status(401).json({ message: "Pengguna tidak terotentikasi." });
    }

    const projectId = req.query.projectId ? String(req.query.projectId).trim() : null;

    let queryText = `
      SELECT t.id, t.project_id, t.title, t.description, t.status, t.deadline, t.priority,
             t.tag, t.progress, t.created_by, t.created_at, t.updated_at, t.sort_order,
             t.sprint_id, t.story_points, t.division_id,
             division.name AS division_name, division.is_active AS division_is_active,
             rp.title AS project_title, rp.short_title AS project_short_title,
             s.name AS sprint_name, s.status AS sprint_status, s.start_date AS sprint_start_date, s.end_date AS sprint_end_date
      FROM research_board_tasks t
      JOIN research_board_task_assignees a ON a.task_id = t.id AND a.user_id = $1
      JOIN research_projects rp ON rp.id = t.project_id
      LEFT JOIN research_sprints s ON s.id = t.sprint_id
      LEFT JOIN research_divisions division ON division.id = t.division_id
    `;
    const queryParams = [userId];

    if (projectId) {
      queryText += ` WHERE t.project_id = $2`;
      queryParams.push(projectId);
    }

    queryText += ` ORDER BY t.status ASC, t.sort_order ASC, t.updated_at DESC`;

    const taskResult = await query(queryText, queryParams);
    const taskIds = taskResult.rows.map((row) => row.id);

    let subtaskRows = [];
    let attachmentRows = [];
    if (taskIds.length > 0) {
      const [subtasks, attachments] = await Promise.all([
        query(
          `SELECT id, task_id, title, done, sort_order FROM research_board_task_subtasks WHERE task_id = ANY($1::text[]) ORDER BY sort_order ASC, id ASC`,
          [taskIds]
        ),
        query(
          `SELECT id, task_id, file_url, file_name, file_size, mime_type, created_at FROM research_board_task_attachments WHERE task_id = ANY($1::text[]) ORDER BY created_at DESC`,
          [taskIds]
        )
      ]);
      subtaskRows = subtasks.rows;
      attachmentRows = attachments.rows;
    }

    const subtasksMap = new Map();
    subtaskRows.forEach((st) => {
      if (!subtasksMap.has(st.task_id)) subtasksMap.set(st.task_id, []);
      subtasksMap.get(st.task_id).push(st);
    });

    const attachmentsMap = new Map();
    attachmentRows.forEach((at) => {
      if (!attachmentsMap.has(at.task_id)) attachmentsMap.set(at.task_id, []);
      attachmentsMap.get(at.task_id).push(at);
    });

    const tasks = taskResult.rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      projectTitle: row.project_short_title || row.project_title,
      title: row.title,
      description: row.description || "",
      status: row.status,
      deadline: row.deadline,
      priority: row.priority,
      tag: row.tag,
      progress: Number(row.progress) || 0,
      sprintId: row.sprint_id,
      sprintName: row.sprint_name || null,
      sprintStatus: row.sprint_status || null,
      divisionId: row.division_id || null,
      division_id: row.division_id || null,
      divisionName: row.division_name || null,
      division_name: row.division_name || null,
      divisionIsActive: row.division_is_active == null ? null : row.division_is_active === true,
      division_is_active: row.division_is_active == null ? null : row.division_is_active === true,
      storyPoints: row.story_points !== null ? Number(row.story_points) : 3,
      sortOrder: Number(row.sort_order) || 0,
      subtasks: subtasksMap.get(row.id) || [],
      attachments: attachmentsMap.get(row.id) || []
    }));

    res.json(tasks);
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    await ensureMeetingNotesTables();
    const role = extractRole(req);
    const userId = resolveRequesterUserId(req);
    const listParams = [];
    const listFilters = buildResearchListFilters(
      { search: req.query.search || req.query.q, status: req.query.status },
      listParams
    );
    let result;

    const meetingSub = `
      LEFT JOIN (
        SELECT project_id,
               COUNT(*)::int            AS meeting_count,
               MAX(meeting_date)::text  AS last_meeting_date
        FROM research_meeting_notes
        GROUP BY project_id
      ) mn ON mn.project_id = rp.id
    `;
    const meetingCols = `,
               COALESCE(mn.meeting_count, 0)  AS meeting_count,
               mn.last_meeting_date`;

    if (role === "operator") {
      result = await query(
        `
        SELECT rp.id, rp.title, rp.short_title, rp.period_text, rp.mitra, rp.status,
               rp.progress, rp.category, rp.description, rp.funding, rp.repositori, rp.attachment_link,
               rp.research_type, rp.agreement_type, rp.agreement_start_date, rp.agreement_end_date, rp.agreement_file_url,
               rp.proposal_file_url, rp.rab_file_url,
               l.id AS supervisor_id, u.name AS supervisor_name, u.initials AS supervisor_initials
               ${meetingCols}
        FROM research_projects rp
        LEFT JOIN lecturers l ON l.id = rp.supervisor_lecturer_id
        LEFT JOIN users u ON u.id = l.user_id
        ${meetingSub}
        ${appendWhere(listFilters, [])}
        ORDER BY rp.id ASC
        LIMIT 500
        `,
        listParams
      );
    } else if (role === "dosen") {
      const params = [userId];
      const shiftedListFilters = buildResearchListFilters(
        { search: req.query.search || req.query.q, status: req.query.status },
        params
      );
      result = await query(
        `
        SELECT DISTINCT rp.id, rp.title, rp.short_title, rp.period_text, rp.mitra, rp.status,
               rp.progress, rp.category, rp.description, rp.funding, rp.repositori, rp.attachment_link,
               rp.research_type, rp.agreement_type, rp.agreement_start_date, rp.agreement_end_date, rp.agreement_file_url,
               rp.proposal_file_url, rp.rab_file_url,
               l.id AS supervisor_id, u.name AS supervisor_name, u.initials AS supervisor_initials
               ${meetingCols}
        FROM research_projects rp
        LEFT JOIN lecturers l ON l.id = rp.supervisor_lecturer_id
        LEFT JOIN users u ON u.id = l.user_id
        LEFT JOIN research_memberships rm ON rm.project_id = rp.id AND COALESCE(rm.status, 'Aktif') = 'Aktif' AND (rm.selesai IS NULL OR rm.selesai >= CURRENT_DATE)
        LEFT JOIN lecturers own_l ON own_l.id = rp.supervisor_lecturer_id
        ${meetingSub}
        ${appendWhere(["(rm.user_id = $1 OR own_l.user_id = $1)"], shiftedListFilters)}
        ORDER BY rp.id ASC
        LIMIT 500
        `,
        params
      );
    } else {
      const params = [userId];
      const shiftedListFilters = buildResearchListFilters(
        { search: req.query.search || req.query.q, status: req.query.status },
        params
      );
      result = await query(
        `
        SELECT DISTINCT rp.id, rp.title, rp.short_title, rp.period_text, rp.mitra, rp.status,
               rp.progress, rp.category, rp.description, rp.funding, rp.repositori, rp.attachment_link,
               rp.research_type, rp.agreement_type, rp.agreement_start_date, rp.agreement_end_date, rp.agreement_file_url,
               rp.proposal_file_url, rp.rab_file_url,
               l.id AS supervisor_id, u.name AS supervisor_name, u.initials AS supervisor_initials
               ${meetingCols}
        FROM research_projects rp
        LEFT JOIN lecturers l ON l.id = rp.supervisor_lecturer_id
        LEFT JOIN users u ON u.id = l.user_id
        LEFT JOIN research_memberships rm ON rm.project_id = rp.id AND COALESCE(rm.status, 'Aktif') = 'Aktif' AND (rm.selesai IS NULL OR rm.selesai >= CURRENT_DATE)
        LEFT JOIN board_access ba ON ba.project_id = rp.id
        ${meetingSub}
        ${appendWhere(["(rm.user_id = $1 OR ba.user_id = $1)"], shiftedListFilters)}
        ORDER BY rp.id ASC
        LIMIT 500
        `,
        params
      );
    }

    res.json(result.rows.map(withResearchDocumentFields));
  })
);

router.get(
  "/:id/members",
  asyncHandler(async (req, res) => {
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role: extractRole(req), projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak untuk melihat anggota riset ini." });
    }

    const result = await query(
      `
      SELECT rm.id, rm.project_id, rm.user_id, u.name, u.initials, u.photo_url, rm.member_type,
             rm.peran,
             CASE WHEN rm.selesai IS NOT NULL AND rm.selesai < CURRENT_DATE THEN 'Nonaktif' ELSE rm.status END AS status,
             rm.bergabung, rm.selesai, u.role,
             s.tipe AS mahasiswa_tipe, s.status AS student_status
      FROM research_memberships rm
      JOIN users u ON u.id = rm.user_id
      LEFT JOIN students s ON s.user_id = u.id
      WHERE rm.project_id = $1
      ORDER BY CASE WHEN rm.status = 'Aktif' THEN 0 ELSE 1 END ASC, rm.member_type ASC, u.name ASC
      `,
      [req.params.id]
    );

    res.json(result.rows);
  })
);

router.get(
  "/:id/board-access",
  asyncHandler(async (req, res) => {
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role: extractRole(req), projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak untuk melihat board access riset ini." });
    }

    const result = await query(
      `
      SELECT ba.user_id, u.name, u.initials, u.photo_url
      FROM board_access ba
      JOIN users u ON u.id = ba.user_id
      WHERE ba.project_id = $1
      ORDER BY u.name ASC
      `,
      [req.params.id]
    );

    res.json(result.rows);
  })
);

router.get(
  "/:id/board",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.hasAccess) {
      return res.status(403).json({ message: "Akses ditolak untuk melihat board riset ini." });
    }

    const snapshot = await fetchBoardSnapshot(req.params.id);
    res.json({
      ...snapshot,
      permissions: {
        role: access.role,
        isLeaderMember: access.isLeaderMember,
        canManageCards: access.isManager,
        canFillExistingCards: access.canFillExistingCards
      }
    });
  })
);

router.get(
  "/:id/milestones",
  asyncHandler(async (req, res) => {
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role: extractRole(req), projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak untuk melihat milestone riset ini." });
    }

    const result = await query(
      `
      SELECT id, project_id, label, done, target_date, sort_order
      FROM research_milestones
      WHERE project_id = $1
      ORDER BY sort_order ASC, id ASC
      `,
      [req.params.id]
    );

    res.json(result.rows);
  })
);

// ─── Board Cards (Logbook Entries) CRUD ──────────────────────────────────────

router.post(
  "/:id/board/cards",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.isManager) {
      return res.status(403).json({
        message: "Akses ditolak. Anggota biasa hanya dapat mengisi card progress yang sudah tersedia."
      });
    }

    const { title, date, description, output, kendala, studentId } = req.body;

    if (!title || !date) {
      return res.status(400).json({ message: "title dan date wajib diisi." });
    }

    if (role === "mahasiswa") {
      const normalizedDate = String(date || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
        return res.status(400).json({ message: "Format tanggal logbook harus YYYY-MM-DD." });
      }

      const todayDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
      if (normalizedDate !== todayDate) {
        return res.status(400).json({
          message: "Tanggal logbook hanya boleh hari ini untuk role mahasiswa."
        });
      }
    }

    // Generate a unique ID for the logbook entry
    const entryId = `LE-${Date.now()}-${require("crypto").randomUUID().slice(0, 8)}`;

    // Resolve student_id if provided, otherwise use a default
    let resolvedStudentId = null;
    if (studentId) {
      const studentCheck = await query("SELECT id FROM students WHERE id = $1 OR user_id = $1 LIMIT 1", [studentId]);
      if (studentCheck.rowCount > 0) {
        resolvedStudentId = studentCheck.rows[0].id;
      }
    }

    // If no studentId provided, find any student from the project
    if (!resolvedStudentId) {
      const anyStudent = await query(
        `SELECT rm.user_id, s.id FROM research_memberships rm
         JOIN students s ON s.user_id = rm.user_id
         WHERE rm.project_id = $1 LIMIT 1`,
        [req.params.id]
      );
      if (anyStudent.rowCount > 0) {
        resolvedStudentId = anyStudent.rows[0].id;
      }
    }

    // If still no student, we need to handle this — use a placeholder
    if (!resolvedStudentId) {
      return res.status(400).json({ message: "Tidak ada mahasiswa di proyek ini. Tambahkan anggota mahasiswa terlebih dahulu." });
    }

    await query(
      `
      INSERT INTO logbook_entries (id, student_id, project_id, date, title, description, output, kendala, has_attachment)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [entryId, resolvedStudentId, req.params.id, date, title, description || null, output || null, kendala || null, false]
    );

    const newEntry = await query(
      `SELECT id, title, date, description, output FROM logbook_entries WHERE id = $1`,
      [entryId]
    );

    res.status(201).json({ message: "Card berhasil ditambahkan.", card: newEntry.rows[0] });
  })
);

router.put(
  "/:id/board/cards/:cardId",
  asyncHandler(async (req, res) => {
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.canFillExistingCards) {
      return res.status(403).json({ message: "Akses ditolak untuk mengedit card di board ini." });
    }

    if (!access.isManager) {
      const allowedFields = ["description", "output", "kendala"];
      const forbiddenFields = Object.keys(req.body || {}).filter((key) => !allowedFields.includes(key));
      if (forbiddenFields.length > 0) {
        return res.status(403).json({
          message: "Anggota biasa hanya dapat mengisi deskripsi, output, atau kendala pada card yang sudah tersedia.",
          forbiddenFields
        });
      }
    }

    const { title, date, description, output, kendala } = req.body;

    const result = await query(
      `
      UPDATE logbook_entries
      SET title = COALESCE($3, title),
          date = COALESCE($4, date),
          description = COALESCE($5, description),
          output = COALESCE($6, output),
          kendala = COALESCE($7, kendala),
          updated_at = NOW()
      WHERE id = $2 AND project_id = $1
      RETURNING id, title, date, description, output
      `,
      [req.params.id, req.params.cardId, title, date, description, output, kendala]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Card tidak ditemukan." });
    }

    res.json({ message: "Card berhasil diperbarui.", card: result.rows[0] });
  })
);

// ── Scrum V2 Division Endpoints ──
router.get(
  "/:id/divisions",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const allowed = await hasProjectAccess({
      userId: resolveRequesterUserId(req),
      role: extractRole(req),
      projectId: req.params.id
    });
    if (!allowed) return res.status(403).json({ message: "Akses ditolak melihat divisi riset." });

    const includeInactive = String(req.query.includeInactive || "").toLowerCase() === "true";
    const result = await query(
      `
      SELECT *
      FROM research_divisions
      WHERE project_id = $1
        AND ($2::boolean = TRUE OR is_active = TRUE)
      ORDER BY sort_order ASC, name ASC
      `,
      [req.params.id, includeInactive]
    );
    res.json(result.rows.map(mapResearchDivision));
  })
);

router.post(
  "/:id/divisions",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.isManager) return res.status(403).json({ message: "Akses ditolak membuat divisi riset." });

    const id = String(req.body?.id || buildEntityId("DIV")).trim();
    const name = normalizeDivisionName(req.body?.name);
    const sortOrder = normalizeDivisionSortOrder(req.body?.sortOrder ?? req.body?.sort_order, 0);
    try {
      const result = await query(
        `
        INSERT INTO research_divisions (id, project_id, name, sort_order)
        VALUES ($1, $2, $3, $4)
        RETURNING *
        `,
        [id, req.params.id, name, sortOrder]
      );
      res.status(201).json({ message: "Divisi riset berhasil dibuat.", division: mapResearchDivision(result.rows[0]) });
    } catch (error) {
      if (error?.code === "23505") throw createHttpError("Nama divisi sudah digunakan pada riset ini.", 409);
      throw error;
    }
  })
);

router.patch(
  "/:id/divisions/:divisionId",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.isManager) return res.status(403).json({ message: "Akses ditolak mengubah divisi riset." });

    const current = await validateProjectDivision({
      projectId: req.params.id,
      divisionId: req.params.divisionId,
      allowInactive: true
    });
    const name = req.body?.name === undefined ? current.name : normalizeDivisionName(req.body.name);
    const sortOrder = normalizeDivisionSortOrder(
      req.body?.sortOrder ?? req.body?.sort_order,
      Number(current.sort_order) || 0
    );
    const activeInput = req.body?.isActive ?? req.body?.is_active;
    if (activeInput !== undefined && typeof activeInput !== "boolean") {
      throw createHttpError("isActive harus berupa boolean.", 400);
    }
    const isActive = activeInput === undefined ? current.is_active === true : activeInput;

    try {
      const result = await query(
        `
        UPDATE research_divisions
        SET name = $3, sort_order = $4, is_active = $5, updated_at = NOW()
        WHERE project_id = $1 AND id = $2
        RETURNING *
        `,
        [req.params.id, req.params.divisionId, name, sortOrder, isActive]
      );
      res.json({ message: "Divisi riset berhasil diperbarui.", division: mapResearchDivision(result.rows[0]) });
    } catch (error) {
      if (error?.code === "23505") throw createHttpError("Nama divisi sudah digunakan pada riset ini.", 409);
      throw error;
    }
  })
);

router.patch(
  "/:id/board/header",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (!["operator", "dosen"].includes(role)) {
      return res.status(403).json({ message: "Role tidak diizinkan mengubah header board riset." });
    }

    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak mengubah header board riset ini." });
    }

    const {
      title,
      shortTitle,
      periodText,
      mitra,
      status,
      progress,
      category,
      description,
      funding,
      repositori,
      attachmentLink
    } = req.body || {};

    const result = await query(
      `
      UPDATE research_projects
      SET title = COALESCE($2, title),
          short_title = COALESCE($3, short_title),
          period_text = COALESCE($4, period_text),
          mitra = COALESCE($5, mitra),
          status = COALESCE($6, status),
          progress = COALESCE($7, progress),
          category = COALESCE($8, category),
          description = COALESCE($9, description),
          funding = COALESCE($10, funding),
          repositori = COALESCE($11, repositori),
          attachment_link = CASE
            WHEN $12::text = '' THEN NULL
            ELSE COALESCE($12, attachment_link)
          END,
          updated_at = NOW()
      WHERE id = $1
      RETURNING id
      `,
      [
        req.params.id,
        title,
        shortTitle,
        periodText,
        mitra,
        status,
        progress,
        category,
        description,
        funding,
        repositori,
        attachmentLink
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Riset tidak ditemukan." });
    }

    const snapshot = await fetchBoardSnapshot(req.params.id);
    res.json({ message: "Header board riset berhasil diperbarui.", project: snapshot.project });
  })
);

router.post(
  "/:id/board/tasks",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.isManager) {
      return res.status(403).json({
        message: "Akses ditolak. Anggota biasa hanya dapat mengisi progress card yang sudah tersedia."
      });
    }

    const {
      id,
      title,
      description,
      status,
      deadline,
      priority,
      tag,
      sprint_id,
      sprintId,
      division_id,
      divisionId,
      story_points,
      storyPoints,
      assignee_ids,
      assigneeIds,
      progress,
      sortOrder
    } = req.body || {};

    if (!String(title || "").trim()) {
      return res.status(400).json({ message: "title task wajib diisi." });
    }

    const nextStatus = normalizeBoardTaskStatus(status);
    const nextSortOrder = Number.isFinite(Number(sortOrder))
      ? Number(sortOrder)
      : await getNextTaskSortOrder(req.params.id, nextStatus);
    const taskId = String(id || buildEntityId("TASK")).trim();
    const nextAssigneeIds = await validateAssigneeIds(assignee_ids ?? assigneeIds);
    const rawSprintId = sprint_id !== undefined ? sprint_id : sprintId;
    const finalSprintId = rawSprintId ? String(rawSprintId).trim() : null;
    const rawDivisionId = division_id !== undefined ? division_id : divisionId;
    const finalDivisionId = rawDivisionId ? String(rawDivisionId).trim() : null;
    const rawStoryPoints = story_points !== undefined ? story_points : storyPoints;
    const finalStoryPoints = Number.isFinite(Number(rawStoryPoints)) ? Math.max(0, parseInt(rawStoryPoints, 10)) : null;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockScrumProject(client, req.params.id);
      await validateProjectDivision({
        projectId: req.params.id,
        divisionId: finalDivisionId,
        executor: client
      });
      await validateProjectSprint({
        projectId: req.params.id,
        sprintId: finalSprintId,
        executor: client
      });
      await client.query(
        `
        INSERT INTO research_board_tasks (
          id, project_id, title, description, status, deadline, priority, tag, progress,
          sort_order, created_by, sprint_id, story_points, division_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        `,
        [
          taskId,
          req.params.id,
          String(title).trim(),
          toNullableText(description),
          nextStatus,
          deadline || null,
          toNullableText(priority),
          toNullableText(tag),
          normalizeProgress(progress, 0),
          nextSortOrder,
          access.userId || null,
          finalSprintId,
          finalStoryPoints,
          finalDivisionId
        ]
      );
      await upsertSprintTaskAssignment({ taskId, sprintId: finalSprintId, executor: client });
      await setTaskAssignees(taskId, nextAssigneeIds, client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const task = await fetchTaskDetail(req.params.id, taskId);
    res.status(201).json({ message: "Task board berhasil ditambahkan.", task });
  })
);

router.get(
  "/:id/board/tasks/:taskId",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role: extractRole(req), projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak melihat detail task board." });
    }

    const task = await fetchTaskDetail(req.params.id, req.params.taskId);
    if (!task) {
      return res.status(404).json({ message: "Task board tidak ditemukan." });
    }

    res.json(task);
  })
);

router.patch(
  "/:id/board/tasks/:taskId",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.canFillExistingCards) {
      return res.status(403).json({ message: "Akses ditolak mengubah task board." });
    }

    if (!access.isManager) {
      const unexpectedFields = getUnexpectedBoardFillFields(req.body || {});
      if (unexpectedFields.length > 0) {
        return res.status(403).json({
          message: "Anggota biasa hanya dapat mengubah progress atau status card yang sudah tersedia.",
          forbiddenFields: unexpectedFields
        });
      }
    }

    const existingTask = await ensureTaskExists(req.params.id, req.params.taskId);
    if (!existingTask) {
      return res.status(404).json({ message: "Task board tidak ditemukan." });
    }

    const detail = await fetchTaskDetail(req.params.id, req.params.taskId);
    const {
      title,
      description,
      status,
      deadline,
      priority,
      tag,
      sprint_id,
      sprintId,
      division_id,
      divisionId,
      story_points,
      storyPoints,
      assignee_ids,
      assigneeIds,
      progress,
      sortOrder
    } = req.body || {};

    const nextStatus = status !== undefined
      ? normalizeBoardTaskStatus(status, detail.status)
      : detail.status;
    const nextSortOrder = sortOrder !== undefined
      ? Number(sortOrder)
      : (nextStatus !== detail.status ? await getNextTaskSortOrder(req.params.id, nextStatus) : detail.sortOrder);
    const nextAssigneeIds = access.isManager && (assignee_ids !== undefined || assigneeIds !== undefined)
      ? await validateAssigneeIds(assignee_ids ?? assigneeIds)
      : detail.assignee_ids;

    const rawSprintId = sprint_id !== undefined ? sprint_id : sprintId;
    const nextSprintId = access.isManager && rawSprintId !== undefined
      ? (rawSprintId ? String(rawSprintId).trim() : null)
      : detail.sprint_id;

    const rawDivisionId = division_id !== undefined ? division_id : divisionId;
    const nextDivisionId = access.isManager && rawDivisionId !== undefined
      ? (rawDivisionId ? String(rawDivisionId).trim() : null)
      : detail.division_id;

    const rawStoryPoints = story_points !== undefined ? story_points : storyPoints;
    const nextStoryPoints = access.isManager && rawStoryPoints !== undefined
      ? (Number.isFinite(Number(rawStoryPoints)) ? Math.max(0, parseInt(rawStoryPoints, 10)) : null)
      : detail.story_points;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockScrumProject(client, req.params.id);
      const lockedTask = await client.query(
        "SELECT sprint_id, division_id FROM research_board_tasks WHERE project_id = $1 AND id = $2 FOR UPDATE",
        [req.params.id, req.params.taskId]
      );
      if (lockedTask.rowCount === 0) throw createHttpError("Task board tidak ditemukan.", 404);
      await assertTaskCurrentSprintMutable({
        projectId: req.params.id,
        taskId: req.params.taskId,
        executor: client
      });

      if (rawSprintId !== undefined && access.isManager) {
        await validateProjectSprint({ projectId: req.params.id, sprintId: nextSprintId, executor: client });
      }
      if (rawDivisionId !== undefined && access.isManager) {
        await validateProjectDivision({ projectId: req.params.id, divisionId: nextDivisionId, executor: client });
      }

      await client.query(
        `
        UPDATE research_board_tasks
        SET title = $3,
            description = $4,
            status = $5,
            deadline = $6,
            priority = $7,
            tag = $8,
            progress = $9,
            sort_order = $10,
            sprint_id = $11,
            story_points = $12,
            division_id = $13,
            updated_at = NOW()
        WHERE project_id = $1 AND id = $2
        `,
        [
          req.params.id,
          req.params.taskId,
          title !== undefined ? String(title).trim() || detail.title : detail.title,
          description !== undefined ? toNullableText(description) : (detail.description || null),
          nextStatus,
          deadline !== undefined ? (deadline || null) : detail.deadline,
          priority !== undefined ? toNullableText(priority) : detail.priority,
          tag !== undefined ? toNullableText(tag) : detail.tag,
          progress !== undefined ? normalizeProgress(progress, detail.progress) : detail.progress,
          Number.isFinite(nextSortOrder) ? nextSortOrder : detail.sortOrder,
          nextSprintId,
          nextStoryPoints,
          nextDivisionId
        ]
      );
      await upsertSprintTaskAssignment({ taskId: req.params.taskId, sprintId: nextSprintId, executor: client });
      await setTaskAssignees(req.params.taskId, nextAssigneeIds, client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const task = await fetchTaskDetail(req.params.id, req.params.taskId);
    res.json({ message: "Task board berhasil diperbarui.", task });
  })
);

router.patch(
  "/:id/board/tasks/:taskId/status",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.canFillExistingCards) {
      return res.status(403).json({ message: "Akses ditolak memindahkan status task board." });
    }

    const existingTask = await ensureTaskExists(req.params.id, req.params.taskId);
    if (!existingTask) {
      return res.status(404).json({ message: "Task board tidak ditemukan." });
    }

    const nextStatus = normalizeBoardTaskStatus(req.body?.status, existingTask.status);
    const nextSortOrder = Number.isFinite(Number(req.body?.sortOrder))
      ? Number(req.body.sortOrder)
      : await getNextTaskSortOrder(req.params.id, nextStatus);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockScrumProject(client, req.params.id);
      await client.query(
        "SELECT id FROM research_board_tasks WHERE project_id = $1 AND id = $2 FOR UPDATE",
        [req.params.id, req.params.taskId]
      );
      await assertTaskCurrentSprintMutable({
        projectId: req.params.id,
        taskId: req.params.taskId,
        executor: client
      });
      await client.query(
        `
        UPDATE research_board_tasks
        SET status = $3,
            sort_order = $4,
            updated_at = NOW()
        WHERE project_id = $1 AND id = $2
        `,
        [req.params.id, req.params.taskId, nextStatus, nextSortOrder]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const task = await fetchTaskDetail(req.params.id, req.params.taskId);
    res.json({ message: "Status task board berhasil diperbarui.", task });

  })
);

// ── GitHub development evidence integration ──
const { isGitHubConfigured, createInstallationAccessToken } = require("../../utils/githubApp");

function repositoryDto(row) {
  return { ...row, projectId: row.project_id, divisionId: row.division_id, githubOwner: row.github_owner, githubRepo: row.github_repo, githubRepositoryId: row.github_repository_id, githubInstallationId: row.github_installation_id, defaultBranch: row.default_branch, isPrivate: row.is_private, isActive: row.is_active };
}
async function requireRepositoryProject(req, manager = false) {
  const access = await getBoardAccessContext({ req, projectId: req.params.id });
  if (manager ? !access.isManager : !access.hasAccess) return null;
  return access;
}
function normalizeGitHubPart(value, label) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(normalized) || normalized.startsWith(".") || normalized.endsWith(".")) throw createHttpError(`${label} tidak valid.`, 400);
  return normalized;
}

router.get("/:id/repositories", asyncHandler(async (req, res) => {
  await ensureResearchBoardTables();
  if (!await requireRepositoryProject(req)) return res.status(403).json({ message: "Akses ditolak." });
  const result = await query("SELECT * FROM research_repositories WHERE project_id = $1 ORDER BY github_owner, github_repo", [req.params.id]);
  res.json({ configured: isGitHubConfigured(), repositories: result.rows.map(repositoryDto) });
}));
router.post("/:id/repositories", asyncHandler(async (req, res) => {
  await ensureResearchBoardTables();
  const access = await requireRepositoryProject(req, true); if (!access) return res.status(403).json({ message: "Akses ditolak." });
  const owner = normalizeGitHubPart(req.body?.owner, "owner"); const repo = normalizeGitHubPart(req.body?.repo, "repo");
  const divisionId = req.body?.divisionId ?? req.body?.division_id ?? null;
  if (divisionId) await validateProjectDivision({ projectId: req.params.id, divisionId: String(divisionId), allowInactive: true });
  const id = String(req.body?.id || buildEntityId("REPO"));
  try {
    const result = await query(`INSERT INTO research_repositories (id, project_id, division_id, github_owner, github_repo, github_repository_id, github_installation_id, default_branch, is_private, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [id, req.params.id, divisionId, owner, repo, req.body?.githubRepositoryId || null, req.body?.githubInstallationId || null, req.body?.defaultBranch || "main", Boolean(req.body?.isPrivate), access.userId]);
    res.status(201).json({ configured: isGitHubConfigured(), repository: repositoryDto(result.rows[0]) });
  } catch (error) { if (error.code === "23505") throw createHttpError("Repository sudah terdaftar pada project ini.", 409, "SCRUM_REPOSITORY_EXISTS"); throw error; }
}));
router.patch("/:id/repositories/:repositoryId", asyncHandler(async (req, res) => {
  await ensureResearchBoardTables();
  const access = await requireRepositoryProject(req, true); if (!access) return res.status(403).json({ message: "Akses ditolak." });
  const current = await query("SELECT * FROM research_repositories WHERE project_id=$1 AND id=$2", [req.params.id, req.params.repositoryId]); if (!current.rowCount) return res.status(404).json({ message: "Repository tidak ditemukan." });
  const b = req.body || {}; const divisionId = b.divisionId ?? b.division_id ?? current.rows[0].division_id; if (divisionId) await validateProjectDivision({ projectId:req.params.id, divisionId:String(divisionId), allowInactive:true });
  const result = await query(`UPDATE research_repositories SET division_id=$3, github_installation_id=$4, default_branch=$5, is_private=$6, is_active=$7, updated_at=NOW() WHERE project_id=$1 AND id=$2 RETURNING *`, [req.params.id, req.params.repositoryId, divisionId || null, b.githubInstallationId ?? current.rows[0].github_installation_id, b.defaultBranch || current.rows[0].default_branch, b.isPrivate === undefined ? current.rows[0].is_private : Boolean(b.isPrivate), b.isActive === undefined ? current.rows[0].is_active : Boolean(b.isActive)]);
  res.json({ repository: repositoryDto(result.rows[0]) });
}));
router.get("/:id/board/tasks/:taskId/repositories", asyncHandler(async (req,res)=>{ if(!await requireRepositoryProject(req)) return res.status(403).json({message:"Akses ditolak."}); const r=await query("SELECT l.*, r.github_owner, r.github_repo FROM research_task_repository_links l JOIN research_repositories r ON r.id=l.repository_id WHERE l.task_id=$1 AND r.project_id=$2 ORDER BY l.created_at DESC",[req.params.taskId,req.params.id]); res.json(r.rows); }));
router.post("/:id/board/tasks/:taskId/repositories", asyncHandler(async(req,res)=>{ const access=await requireRepositoryProject(req,true); if(!access)return res.status(403).json({message:"Akses ditolak."}); const task=await ensureTaskExists(req.params.id,req.params.taskId); if(!task)return res.status(404).json({message:"Task tidak ditemukan."}); const repo=await query("SELECT id FROM research_repositories WHERE id=$1 AND project_id=$2 AND is_active=true",[req.body?.repositoryId,req.params.id]); if(!repo.rowCount)return res.status(400).json({message:"Repository harus berasal dari project yang sama."}); const id=buildEntityId("TRL"); try { const r=await query("INSERT INTO research_task_repository_links (id,task_id,repository_id,branch_name,link_source,created_by) VALUES ($1,$2,$3,$4,'manual',$5) RETURNING *",[id,req.params.taskId,req.body.repositoryId,req.body.branchName||null,access.userId]); res.status(201).json(r.rows[0]); } catch(e){if(e.code==='23505')throw createHttpError("Task sudah terhubung ke repository tersebut.",409,"SCRUM_TASK_REPOSITORY_EXISTS");throw e;} }));
router.delete("/:id/board/tasks/:taskId/repositories/:repositoryId", asyncHandler(async(req,res)=>{ const access=await requireRepositoryProject(req,true); if(!access)return res.status(403).json({message:"Akses ditolak."}); await query("DELETE FROM research_task_repository_links l USING research_repositories r WHERE l.repository_id=r.id AND l.task_id=$1 AND l.repository_id=$2 AND r.project_id=$3",[req.params.taskId,req.params.repositoryId,req.params.id]); res.status(204).end(); }));

router.get("/:id/board/tasks/:taskId/github-activity", asyncHandler(async(req,res)=>{ if(!await requireRepositoryProject(req))return res.status(403).json({message:"Akses ditolak."}); const limit=Math.min(Math.max(Number(req.query.limit)||50,1),200); const r=await query("SELECT a.* FROM research_github_activities a JOIN research_board_tasks t ON t.id=a.task_id WHERE t.project_id=$1 AND t.id=$2 ORDER BY a.occurred_at DESC NULLS LAST,a.created_at DESC LIMIT $3",[req.params.id,req.params.taskId,limit]); res.json(r.rows); }));
router.get("/:id/github-activity", asyncHandler(async(req,res)=>{ if(!await requireRepositoryProject(req))return res.status(403).json({message:"Akses ditolak."}); const limit=Math.min(Math.max(Number(req.query.limit)||50,1),200); const p=[req.params.id]; const f=["r.project_id=$1"]; if(req.query.divisionId){p.push(req.query.divisionId);f.push(`t.division_id=$${p.length}`);} if(req.query.sprintId){p.push(req.query.sprintId);f.push(`(t.sprint_id=$${p.length} OR EXISTS (SELECT 1 FROM research_sprint_task_assignments h WHERE h.sprint_id=$${p.length} AND h.task_id=a.task_id))`);} p.push(limit); const r=await query(`SELECT a.* FROM research_github_activities a JOIN research_repositories r ON r.id=a.repository_id LEFT JOIN research_board_tasks t ON t.id=a.task_id WHERE ${f.join(' AND ')} ORDER BY a.occurred_at DESC NULLS LAST,a.created_at DESC LIMIT $${p.length}`,p); res.json(r.rows); }));

router.delete(

  "/:id/board/cards/:cardId",
  asyncHandler(async (req, res) => {
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.isManager) {
      return res.status(403).json({
        message: "Akses ditolak. Anggota biasa tidak dapat menghapus card progress."
      });
    }

    // Delete associated comments first
    await query("DELETE FROM logbook_comments WHERE logbook_entry_id = $1", [req.params.cardId]);

    const result = await query(
      "DELETE FROM logbook_entries WHERE id = $1 AND project_id = $2 RETURNING id",
      [req.params.cardId, req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Card tidak ditemukan." });
    }

    res.json({ message: "Card berhasil dihapus." });
  })
);

router.delete(
  "/:id/board/tasks/:taskId",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.isManager) {
      return res.status(403).json({
        message: "Akses ditolak. Anggota biasa tidak dapat menghapus card progress."
      });
    }

    await assertTaskCurrentSprintMutable({
      projectId: req.params.id,
      taskId: req.params.taskId
    });

    const historicalAssignment = await query(
      `
      SELECT sprint.status
      FROM research_sprint_task_assignments assignment
      JOIN research_sprints sprint ON sprint.id = assignment.sprint_id
      WHERE assignment.task_id = $1
        AND sprint.status IN ('active', 'review', 'closed')
      LIMIT 1
      `,
      [req.params.taskId]
    );
    if (historicalAssignment.rowCount > 0) {
      throw createHttpError(
        "Task yang sudah menjadi bagian Sprint berjalan atau historis tidak dapat dihapus.",
        409,
        "SCRUM_TASK_HISTORY_PROTECTED"
      );
    }

    const attachmentRows = await query(
      `
      SELECT file_url
      FROM research_board_task_attachments
      WHERE task_id = $1
      `,
      [req.params.taskId]
    );

    const result = await query(
      `
      DELETE FROM research_board_tasks
      WHERE project_id = $1 AND id = $2
      RETURNING id
      `,
      [req.params.id, req.params.taskId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Task board tidak ditemukan." });
    }

    for (const row of attachmentRows.rows) {
      try {
        await removeBoardAttachmentFile(row.file_url);
      } catch {
        // Ignore orphaned file cleanup failures after DB delete succeeds.
      }
    }

    res.json({ message: "Task board berhasil dihapus." });
  })
);

router.post(
  "/:id/board/tasks/:taskId/subtasks",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.isManager) {
      return res.status(403).json({
        message: "Akses ditolak. Anggota biasa hanya dapat mencentang checklist yang sudah tersedia."
      });
    }

    const task = await ensureTaskExists(req.params.id, req.params.taskId);
    if (!task) {
      return res.status(404).json({ message: "Task board tidak ditemukan." });
    }

    const { id, title, done = false, sortOrder } = req.body || {};
    if (!String(title || "").trim()) {
      return res.status(400).json({ message: "title subtask wajib diisi." });
    }

    const subtaskId = String(id || buildEntityId("SUBTASK")).trim();
    const nextSortOrder = Number.isFinite(Number(sortOrder))
      ? Number(sortOrder)
      : (
          await query(
            `
            SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
            FROM research_board_task_subtasks
            WHERE task_id = $1
            `,
            [req.params.taskId]
          )
        ).rows[0]?.next_sort_order || 0;

    await query(
      `
      INSERT INTO research_board_task_subtasks (id, task_id, title, done, sort_order)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [subtaskId, req.params.taskId, String(title).trim(), Boolean(done), Number(nextSortOrder)]
    );

    const updatedTask = await fetchTaskDetail(req.params.id, req.params.taskId);
    res.status(201).json({
      message: "Subtask berhasil ditambahkan.",
      subtask: updatedTask?.subtasks.find((item) => item.id === subtaskId) || null,
      task: updatedTask
    });
  })
);

router.patch(
  "/:id/board/tasks/:taskId/subtasks/:subtaskId",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.canFillExistingCards) {
      return res.status(403).json({ message: "Akses ditolak mengubah subtask." });
    }

    if (!access.isManager) {
      const allowedFields = ["done"];
      const forbiddenFields = Object.keys(req.body || {}).filter((key) => !allowedFields.includes(key));
      if (forbiddenFields.length > 0) {
        return res.status(403).json({
          message: "Anggota biasa hanya dapat mencentang checklist yang sudah tersedia.",
          forbiddenFields
        });
      }
    }

    const result = await query(
      `
      UPDATE research_board_task_subtasks
      SET title = COALESCE($3, title),
          done = COALESCE($4, done),
          sort_order = COALESCE($5, sort_order),
          updated_at = NOW()
      WHERE task_id = $1 AND id = $2
      RETURNING id
      `,
      [
        req.params.taskId,
        req.params.subtaskId,
        req.body?.title !== undefined ? String(req.body.title).trim() : null,
        req.body?.done !== undefined ? Boolean(req.body.done) : null,
        req.body?.sortOrder !== undefined ? Number(req.body.sortOrder) : null
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Subtask tidak ditemukan." });
    }

    const task = await fetchTaskDetail(req.params.id, req.params.taskId);
    res.json({
      message: "Subtask berhasil diperbarui.",
      subtask: task?.subtasks.find((item) => item.id === req.params.subtaskId) || null,
      task
    });
  })
);

router.delete(
  "/:id/board/tasks/:taskId/subtasks/:subtaskId",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.isManager) {
      return res.status(403).json({
        message: "Akses ditolak. Anggota biasa tidak dapat menghapus checklist."
      });
    }

    const result = await query(
      `
      DELETE FROM research_board_task_subtasks
      WHERE task_id = $1 AND id = $2
      RETURNING id
      `,
      [req.params.taskId, req.params.subtaskId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Subtask tidak ditemukan." });
    }

    const task = await fetchTaskDetail(req.params.id, req.params.taskId);
    res.json({ message: "Subtask berhasil dihapus.", task });
  })
);

router.post(
  "/:id/board/tasks/:taskId/attachments",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.canFillExistingCards) {
      return res.status(403).json({ message: "Akses ditolak menambah lampiran task." });
    }

    const task = await ensureTaskExists(req.params.id, req.params.taskId);
    if (!task) {
      return res.status(404).json({ message: "Task board tidak ditemukan." });
    }

    const { id, fileDataUrl, fileName } = req.body || {};
    if (!String(fileDataUrl || "").trim() || !String(fileName || "").trim()) {
      return res.status(400).json({ message: "fileDataUrl dan fileName wajib diisi." });
    }

    let uploadedAttachment;
    try {
      uploadedAttachment = await saveBoardAttachmentFile(String(fileDataUrl).trim(), String(fileName).trim());
    } catch (error) {
      return res.status(error?.statusCode || 400).json({
        message: error?.message || "Gagal upload lampiran task."
      });
    }

    const attachmentId = String(id || buildEntityId("TASKFILE")).trim();
    await query(
      `
      INSERT INTO research_board_task_attachments (
        id, task_id, file_url, file_name, file_size, mime_type, uploaded_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        attachmentId,
        req.params.taskId,
        uploadedAttachment.fileUrl,
        uploadedAttachment.fileName,
        uploadedAttachment.fileSize,
        uploadedAttachment.mimeType,
        access.userId || null
      ]
    );

    const updatedTask = await fetchTaskDetail(req.params.id, req.params.taskId);
    res.status(201).json({
      message: "Lampiran task berhasil ditambahkan.",
      attachment: updatedTask?.attachments.find((item) => item.id === attachmentId) || null,
      task: updatedTask
    });
  })
);

router.delete(
  "/:id/board/tasks/:taskId/attachments/:attachmentId",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.isManager) {
      return res.status(403).json({
        message: "Akses ditolak. Anggota biasa tidak dapat menghapus lampiran card."
      });
    }

    const result = await query(
      `
      DELETE FROM research_board_task_attachments
      WHERE task_id = $1 AND id = $2
      RETURNING id, file_url
      `,
      [req.params.taskId, req.params.attachmentId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Lampiran task tidak ditemukan." });
    }

    try {
      await removeBoardAttachmentFile(result.rows[0].file_url);
    } catch {
      // Metadata delete succeeded; ignore cleanup failure for now.
    }

    const task = await fetchTaskDetail(req.params.id, req.params.taskId);
    res.json({ message: "Lampiran task berhasil dihapus.", task });
  })
);

router.get(
  "/:id/board/tasks/:taskId/comments",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role: extractRole(req), projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak melihat komentar task." });
    }

    const task = await fetchTaskDetail(req.params.id, req.params.taskId);
    if (!task) {
      return res.status(404).json({ message: "Task board tidak ditemukan." });
    }

    res.json(task.comments || []);
  })
);

router.post(
  "/:id/board/tasks/:taskId/comments",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.canFillExistingCards) {
      return res.status(403).json({ message: "Akses ditolak menambah komentar task." });
    }

    const task = await ensureTaskExists(req.params.id, req.params.taskId);
    if (!task) {
      return res.status(404).json({ message: "Task board tidak ditemukan." });
    }

    const authorId = String(req.body?.authorId || access.userId || "").trim();
    const text = String(req.body?.text || "").trim();
    if (!authorId || !text) {
      return res.status(400).json({ message: "authorId dan text wajib diisi." });
    }

    const commentId = String(req.body?.id || buildEntityId("TASKCMT")).trim();
    await query(
      `
      INSERT INTO research_board_task_comments (id, task_id, author_id, author_name, text)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [commentId, req.params.taskId, authorId, toNullableText(req.body?.authorName), text]
    );

    const updatedTask = await fetchTaskDetail(req.params.id, req.params.taskId);
    res.status(201).json({
      message: "Komentar task berhasil ditambahkan.",
      comment: updatedTask?.comments.find((item) => item.id === commentId) || null,
      task: updatedTask
    });

  })
);

// ── Sprints Endpoints ──
router.get(
  "/:id/sprints",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const allowed = await hasProjectAccess({
      userId: resolveRequesterUserId(req),
      role: extractRole(req),
      projectId: req.params.id
    });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak melihat sprint riset." });
    }

    const sprints = await fetchProjectSprints(req.params.id);
    res.json(sprints);
  })
);

function validateSprintDateRange(rawStart, rawEnd) {
  const startStr = rawStart ? formatDateOnly(rawStart) : null;
  const endStr = rawEnd ? formatDateOnly(rawEnd) : null;

  if (startStr && !/^\d{4}-\d{2}-\d{2}$/.test(startStr)) {
    throw createHttpError("Format start_date tidak valid (harus YYYY-MM-DD).", 400);
  }
  if (endStr && !/^\d{4}-\d{2}-\d{2}$/.test(endStr)) {
    throw createHttpError("Format end_date tidak valid (harus YYYY-MM-DD).", 400);
  }
  if (startStr && isNaN(Date.parse(startStr))) {
    throw createHttpError("Nilai start_date tidak valid.", 400);
  }
  if (endStr && isNaN(Date.parse(endStr))) {
    throw createHttpError("Nilai end_date tidak valid.", 400);
  }
  if (startStr && endStr && endStr < startStr) {
    throw createHttpError("end_date tidak boleh mendahului start_date.", 400);
  }
  return { startDate: startStr, endDate: endStr };
}

router.post(
  "/:id/sprints",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.isManager) {
      return res.status(403).json({ message: "Akses ditolak membuat sprint." });
    }

    const { name, goal, startDate, start_date, endDate, end_date, status } = req.body || {};
    if (!String(name || "").trim()) {
      return res.status(400).json({ message: "Nama sprint wajib diisi." });
    }

    const { startDate: resolvedStart, endDate: resolvedEnd } = validateSprintDateRange(
      startDate || start_date || null,
      endDate || end_date || null
    );

    const sprintId = String(req.body?.id || buildEntityId("SPRINT")).trim();
    const sprintStatus = status == null || status === "" ? "planning" : String(status).trim().toLowerCase();
    if (!["planning", "active"].includes(sprintStatus)) {
      throw createHttpError("Sprint baru hanya dapat dibuat dalam status planning atau active.", 400);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockScrumProject(client, req.params.id);
      if (sprintStatus === "active") await assertSprintCanActivate(client, req.params.id, sprintId);
      await client.query(
        `
        INSERT INTO research_sprints (id, project_id, name, goal, start_date, end_date, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          sprintId,
          req.params.id,
          String(name).trim(),
          toNullableText(goal),
          resolvedStart,
          resolvedEnd,
          sprintStatus
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      rethrowSprintUniqueViolation(error);
    } finally {
      client.release();
    }

    const sprints = await fetchProjectSprints(req.params.id);
    const sprint = sprints.find((s) => s.id === sprintId);
    res.status(201).json({ message: "Sprint berhasil dibuat.", sprint });
  })
);

router.patch(
  "/:id/sprints/:sprintId",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.isManager) {
      return res.status(403).json({ message: "Akses ditolak mengubah sprint." });
    }

    const { name, goal, startDate, start_date, endDate, end_date, status } = req.body || {};
    const requestedStatus = status == null || status === ""
      ? null
      : (String(status).trim().toLowerCase() === "completed" ? "review" : String(status).trim().toLowerCase());
    if (requestedStatus && !["planning", "active", "review", "closed"].includes(requestedStatus)) {
      throw createHttpError("Status Sprint tidak valid.", 400);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockScrumProject(client, req.params.id);
      const existing = await client.query(
        "SELECT * FROM research_sprints WHERE project_id = $1 AND id = $2 FOR UPDATE",
        [req.params.id, req.params.sprintId]
      );
      if (existing.rowCount === 0) throw createHttpError("Sprint tidak ditemukan.", 404);
      const current = existing.rows[0];
      if (current.status === "closed") {
        throw createHttpError("Sprint closed bersifat read-only.", 409, "SCRUM_SPRINT_CLOSED");
      }
      if (requestedStatus === "active" && current.status !== "planning") {
        throw createHttpError(
          "Sprint hanya dapat dimulai dari status planning.",
          409,
          "SCRUM_SPRINT_NOT_PLANNING"
        );
      }

      const nextStatus = requestedStatus || current.status;
      const transition = `${current.status}:${nextStatus}`;
      const allowedTransitions = new Set([
        "planning:planning",
        "planning:active",
        "active:active",
        "active:review",
        "review:review"
      ]);
      if (!allowedTransitions.has(transition)) {
        throw createHttpError(
          `Perubahan status Sprint ${current.status} → ${nextStatus} tidak diizinkan.`,
          409,
          "SCRUM_INVALID_SPRINT_TRANSITION"
        );
      }
      if (transition === "planning:active") {
        await assertSprintCanActivate(client, req.params.id, req.params.sprintId);
      }

      const nextStart = startDate !== undefined || start_date !== undefined
        ? (startDate || start_date || null)
        : current.start_date;
      const nextEnd = endDate !== undefined || end_date !== undefined
        ? (endDate || end_date || null)
        : current.end_date;
      const { startDate: resolvedStart, endDate: resolvedEnd } = validateSprintDateRange(nextStart, nextEnd);

      await client.query(
        `
        UPDATE research_sprints
        SET name = $3,
            goal = $4,
            start_date = $5,
            end_date = $6,
            status = $7,
            review_started_at = CASE
              WHEN $7 = 'review' AND review_started_at IS NULL THEN NOW()
              ELSE review_started_at
            END,
            updated_at = NOW()
        WHERE project_id = $1 AND id = $2
        `,
        [
          req.params.id,
          req.params.sprintId,
          name !== undefined ? String(name).trim() || current.name : current.name,
          goal !== undefined ? toNullableText(goal) : current.goal,
          resolvedStart,
          resolvedEnd,
          nextStatus
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      rethrowSprintUniqueViolation(error);
    } finally {
      client.release();
    }

    const sprints = await fetchProjectSprints(req.params.id);
    const sprint = sprints.find((s) => s.id === req.params.sprintId);
    res.json({ message: "Sprint berhasil diperbarui.", sprint });
  })
);

router.delete(
  "/:id/sprints/:sprintId",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.isManager) {
      return res.status(403).json({ message: "Akses ditolak menghapus sprint." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockScrumProject(client, req.params.id);
      const existing = await client.query(
        "SELECT id, status FROM research_sprints WHERE project_id = $1 AND id = $2 FOR UPDATE",
        [req.params.id, req.params.sprintId]
      );
      if (existing.rowCount === 0) throw createHttpError("Sprint tidak ditemukan.", 404);
      if (existing.rows[0].status !== "planning") {
        throw createHttpError("Hanya Sprint planning yang dapat dihapus.", 409, "SCRUM_SPRINT_DELETE_FORBIDDEN");
      }
      await client.query(
        "UPDATE research_board_tasks SET sprint_id = NULL, updated_at = NOW() WHERE project_id = $1 AND sprint_id = $2",
        [req.params.id, req.params.sprintId]
      );
      await client.query(
        "DELETE FROM research_sprints WHERE project_id = $1 AND id = $2",
        [req.params.id, req.params.sprintId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    res.json({ message: "Sprint berhasil dihapus." });
  })
);

// ── Sprint Review / Summary / Finalization ──
async function requireReviewSprint({ client, projectId, sprintId, forUpdate = false }) {
  const result = await client.query(
    `SELECT * FROM research_sprints WHERE project_id = $1 AND id = $2 ${forUpdate ? "FOR UPDATE" : ""}`,
    [projectId, sprintId]
  );
  if (result.rowCount === 0) throw createHttpError("Sprint tidak ditemukan.", 404);
  if (result.rows[0].status === "closed") throw createHttpError("Sprint closed bersifat read-only.", 409, "SCRUM_SPRINT_CLOSED");
  if (result.rows[0].status !== "review") throw createHttpError("Summary dan Review hanya dapat diisi saat Sprint berstatus review.", 409, "SCRUM_SPRINT_NOT_REVIEW");
  return result.rows[0];
}

router.get(
  "/:id/sprints/:sprintId/summary",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role: extractRole(req), projectId: req.params.id });
    if (!allowed) return res.status(403).json({ message: "Akses ditolak melihat summary Sprint." });
    const state = await loadSprintReviewState({ projectId: req.params.id, sprintId: req.params.sprintId });
    const targetResult = await query(
      `SELECT id, project_id, name, goal, start_date, end_date, status
       FROM research_sprints
       WHERE project_id = $1 AND status = 'planning' AND id <> $2
       ORDER BY created_at ASC`,
      [req.params.id, req.params.sprintId]
    );
    const response = mapSummaryResponse(state);
    response.sprint = (await fetchProjectSprints(req.params.id)).find((row) => row.id === req.params.sprintId) || state.sprint;
    response.planningTargetSprints = targetResult.rows;
    res.json(response);
  })
);

router.put(
  "/:id/sprints/:sprintId/summary",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.isManager) return res.status(403).json({ message: "Akses ditolak menyimpan summary Sprint." });
    const summaryText = String(req.body?.summary ?? "").trim();
    if (!summaryText) return res.status(400).json({ message: "Summary utama wajib diisi." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockScrumProject(client, req.params.id);
      const sprint = await requireReviewSprint({ client, projectId: req.params.id, sprintId: req.params.sprintId, forUpdate: true });
      const existing = await client.query("SELECT is_finalized FROM research_sprint_summaries WHERE sprint_id = $1", [req.params.sprintId]);
      if (existing.rows[0]?.is_finalized) throw createHttpError("Summary Sprint sudah difinalisasi.", 409, "SCRUM_SUMMARY_FINALIZED");
      const result = await client.query(
        `INSERT INTO research_sprint_summaries
           (id, sprint_id, summary, achievements, challenges, lessons_learned, next_sprint_plan, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (sprint_id) DO UPDATE SET
           summary = EXCLUDED.summary,
           achievements = EXCLUDED.achievements,
           challenges = EXCLUDED.challenges,
           lessons_learned = EXCLUDED.lessons_learned,
           next_sprint_plan = EXCLUDED.next_sprint_plan,
           updated_at = NOW()
         RETURNING *`,
        [
          `SUMMARY-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
          sprint.id,
          summaryText,
          toNullableText(req.body?.achievements),
          toNullableText(req.body?.challenges),
          toNullableText(req.body?.lessonsLearned ?? req.body?.lessons_learned),
          toNullableText(req.body?.nextSprintPlan ?? req.body?.next_sprint_plan),
          access.userId || null
        ]
      );
      await client.query("COMMIT");
      res.json({ message: "Summary Sprint berhasil disimpan.", summary: mapSprintSummary(result.rows[0]) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  })
);

router.put(
  "/:id/sprints/:sprintId/review-meeting",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.isManager) return res.status(403).json({ message: "Akses ditolak menyimpan Review Meeting." });
    const attendeeUserIds = Array.from(new Set((Array.isArray(req.body?.attendeeUserIds) ? req.body.attendeeUserIds : req.body?.attendee_user_ids || []).map((id) => String(id).trim()).filter(Boolean)));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockScrumProject(client, req.params.id);
      const sprint = await requireReviewSprint({ client, projectId: req.params.id, sprintId: req.params.sprintId, forUpdate: true });
      if (req.body?.chairUserId) {
        const chair = await client.query("SELECT id FROM users WHERE id = $1", [req.body.chairUserId]);
        if (chair.rowCount === 0) throw createHttpError("Chair Review Meeting tidak ditemukan.", 400);
      }
      if (attendeeUserIds.length > 0) {
        const members = await client.query(
          `SELECT u.id FROM users u JOIN research_memberships m ON m.user_id = u.id
           WHERE m.project_id = $1 AND m.status = 'Aktif' AND u.id = ANY($2::text[])`,
          [req.params.id, attendeeUserIds]
        );
        if (members.rowCount !== attendeeUserIds.length) throw createHttpError("Attendee harus merupakan anggota aktif pada project yang sama.", 400);
      }
      const meeting = await client.query(
        `INSERT INTO research_sprint_review_meetings
           (id, sprint_id, meeting_date, start_time, location, meeting_link, chair_user_id, agenda, notes, decisions, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (sprint_id) DO UPDATE SET
           meeting_date = EXCLUDED.meeting_date, start_time = EXCLUDED.start_time,
           location = EXCLUDED.location, meeting_link = EXCLUDED.meeting_link,
           chair_user_id = EXCLUDED.chair_user_id, agenda = EXCLUDED.agenda,
           notes = EXCLUDED.notes, decisions = EXCLUDED.decisions, updated_at = NOW()
         RETURNING *`,
        [
          `MEETING-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
          sprint.id,
          req.body?.meetingDate ?? req.body?.meeting_date ?? null,
          req.body?.startTime ?? req.body?.start_time ?? null,
          toNullableText(req.body?.location),
          toNullableText(req.body?.meetingLink ?? req.body?.meeting_link),
          req.body?.chairUserId ?? req.body?.chair_user_id ?? null,
          toNullableText(req.body?.agenda),
          toNullableText(req.body?.notes),
          toNullableText(req.body?.decisions),
          access.userId || null
        ]
      );
      await client.query("DELETE FROM research_sprint_review_attendees WHERE meeting_id = $1", [meeting.rows[0].id]);
      for (const userId of attendeeUserIds) {
        const user = await client.query("SELECT id, name, role FROM users WHERE id = $1", [userId]);
        await client.query(
          `INSERT INTO research_sprint_review_attendees (meeting_id, user_id, name_snapshot, role_snapshot)
           VALUES ($1,$2,$3,$4)`,
          [meeting.rows[0].id, userId, user.rows[0].name, user.rows[0].role]
        );
      }
      const attendees = await client.query("SELECT * FROM research_sprint_review_attendees WHERE meeting_id = $1 ORDER BY name_snapshot", [meeting.rows[0].id]);
      await client.query("COMMIT");
      res.json({ message: "Review Meeting berhasil disimpan.", meeting: mapReviewMeeting(meeting.rows[0], attendees.rows.map((row) => ({ userId: row.user_id, user_id: row.user_id, name: row.name_snapshot, nameSnapshot: row.name_snapshot, role: row.role_snapshot }))) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  })
);

router.put(
  "/:id/sprints/:sprintId/evaluations/:userId",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.isManager) return res.status(403).json({ message: "Akses ditolak menyimpan evaluasi anggota." });
    if (String(access.userId) === String(req.params.userId)) return res.status(403).json({ message: "Anda tidak dapat mengevaluasi diri sendiri.", code: "SCRUM_SELF_EVALUATION_FORBIDDEN" });
    const scoreFields = ["taskCompletion", "quality", "timeliness", "collaboration", "initiative"];
    const scores = scoreFields.map((field) => Number(req.body?.[field] ?? req.body?.[field.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)]));
    if (scores.some((score) => !Number.isInteger(score) || score < 1 || score > 10)) throw createHttpError("Semua skor evaluasi harus integer 1 sampai 10.", 400, "SCRUM_EVALUATION_SCORE_INVALID");
    const notes = String(req.body?.notes || "").trim();
    if (!notes) throw createHttpError("Catatan evaluasi wajib diisi.", 400, "SCRUM_EVALUATION_NOTES_REQUIRED");
    const required = await getRequiredEvaluationMembers(req.params.id, req.params.sprintId);
    if (!required.some((member) => member.id === req.params.userId)) throw createHttpError("Anggota evaluasi tidak termasuk dalam histori Sprint.", 400);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockScrumProject(client, req.params.id);
      const sprint = await requireReviewSprint({ client, projectId: req.params.id, sprintId: req.params.sprintId, forUpdate: true });
      const result = await client.query(
        `INSERT INTO research_sprint_member_evaluations
           (id, sprint_id, evaluated_user_id, task_completion, quality, timeliness, collaboration, initiative, overall_score, notes, created_by)
         VALUES ($1,$2,$3,$4::int,$5::int,$6::int,$7::int,$8::int,ROUND(($4::numeric+$5::numeric+$6::numeric+$7::numeric+$8::numeric) / 5, 2),$9,$10)
         ON CONFLICT (sprint_id, evaluated_user_id) DO UPDATE SET
           task_completion = EXCLUDED.task_completion, quality = EXCLUDED.quality,
           timeliness = EXCLUDED.timeliness, collaboration = EXCLUDED.collaboration,
           initiative = EXCLUDED.initiative, overall_score = EXCLUDED.overall_score,
           notes = EXCLUDED.notes, updated_at = NOW()
         RETURNING *`,
        [`EVAL-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`, sprint.id, req.params.userId, ...scores, notes, access.userId || null]
      );
      await client.query("COMMIT");
      res.json({ message: "Evaluasi anggota berhasil disimpan.", evaluation: mapEvaluation(result.rows[0]) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  })
);

router.put(
  "/:id/sprints/:sprintId/tasks/:taskId/outcome",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.isManager) return res.status(403).json({ message: "Akses ditolak menyimpan outcome task." });
    const outcome = String(req.body?.outcome || "").trim().toLowerCase();
    if (!["carry_over", "backlog", "cancelled"].includes(outcome)) throw createHttpError("Outcome task tidak valid.", 400, "SCRUM_OUTCOME_INVALID");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockScrumProject(client, req.params.id);
      await requireReviewSprint({ client, projectId: req.params.id, sprintId: req.params.sprintId });
      const assignment = await client.query(
        `SELECT a.*, t.title FROM research_sprint_task_assignments a
         JOIN research_board_tasks t ON t.id = a.task_id
         WHERE a.sprint_id = $1 AND a.task_id = $2 FOR UPDATE`,
        [req.params.sprintId, req.params.taskId]
      );
      if (assignment.rowCount === 0) throw createHttpError("Task tidak ditemukan pada Sprint tersebut.", 404);
      let targetSprintId = req.body?.targetSprintId ?? req.body?.target_sprint_id ?? null;
      if (outcome === "carry_over") {
        targetSprintId = targetSprintId ? String(targetSprintId).trim() : null;
        if (!targetSprintId) throw createHttpError("Target Sprint planning wajib dipilih untuk carry-over.", 400, "SCRUM_CARRY_OVER_TARGET_REQUIRED");
        const target = await client.query("SELECT id, status FROM research_sprints WHERE project_id = $1 AND id = $2", [req.params.id, targetSprintId]);
        if (target.rowCount === 0 || target.rows[0].status !== "planning") throw createHttpError("Carry-over hanya dapat menuju Sprint planning pada project yang sama.", 409, "SCRUM_INVALID_CARRY_OVER_TARGET");
      } else {
        targetSprintId = null;
      }
      const result = await client.query(
        `UPDATE research_sprint_task_assignments
         SET outcome = $3, target_sprint_id = $4
         WHERE sprint_id = $1 AND task_id = $2 RETURNING *`,
        [req.params.sprintId, req.params.taskId, outcome, targetSprintId]
      );
      await client.query("COMMIT");
      res.json({ message: "Outcome task berhasil disimpan.", outcome: result.rows[0].outcome, targetSprintId: result.rows[0].target_sprint_id });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  })
);

router.post(
  "/:id/sprints/:sprintId/finalize",
  asyncHandler(async (req, res) => {
    await ensureResearchBoardTables();
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    if (!access.isManager) return res.status(403).json({ message: "Akses ditolak memfinalisasi Sprint." });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockScrumProject(client, req.params.id);
      const sprintResult = await client.query("SELECT * FROM research_sprints WHERE project_id = $1 AND id = $2 FOR UPDATE", [req.params.id, req.params.sprintId]);
      if (sprintResult.rowCount === 0) throw createHttpError("Sprint tidak ditemukan.", 404);
      if (sprintResult.rows[0].status === "closed") throw createHttpError("Sprint sudah difinalisasi.", 409, "SCRUM_SPRINT_ALREADY_FINALIZED");
      if (sprintResult.rows[0].status !== "review") throw createHttpError("Sprint harus berstatus review sebelum difinalisasi.", 409, "SCRUM_SPRINT_NOT_REVIEW");
      const assignments = await client.query("SELECT * FROM research_sprint_task_assignments WHERE sprint_id = $1 FOR UPDATE", [req.params.sprintId]);
      const taskIds = assignments.rows.map((row) => row.task_id);
      const tasksResult = await client.query("SELECT * FROM research_board_tasks WHERE id = ANY($1::text[]) FOR UPDATE", [taskIds]);
      const state = await loadSprintReviewState({ projectId: req.params.id, sprintId: req.params.sprintId, executor: client });
      if (!state.canFinalize) throw createHttpError("Sprint belum siap difinalisasi.", 409, "SCRUM_SPRINT_FINALIZATION_BLOCKED");
      const taskMap = new Map(tasksResult.rows.map((row) => [row.id, row]));
      const targetIds = [...new Set(assignments.rows.filter((row) => row.outcome === "carry_over").map((row) => row.target_sprint_id).filter(Boolean))];
      const targetRows = targetIds.length > 0
        ? await client.query("SELECT * FROM research_sprints WHERE project_id = $1 AND id = ANY($2::text[]) FOR UPDATE", [req.params.id, targetIds])
        : { rows: [] };
      const targetMap = new Map(targetRows.rows.map((row) => [row.id, row]));
      for (const targetId of targetIds) {
        if (targetMap.get(targetId)?.status !== "planning") throw createHttpError("Target carry-over berubah dan tidak lagi planning.", 409, "SCRUM_INVALID_CARRY_OVER_TARGET");
      }
      for (const assignment of assignments.rows) {
        const task = taskMap.get(assignment.task_id);
        const isDone = String(task.status).toUpperCase() === "DONE";
        let outcome = assignment.outcome;
        if (isDone) outcome = "done";
        await client.query(
          `UPDATE research_sprint_task_assignments
           SET outcome = $3, status_at_close = $4, progress_at_close = $5, closed_at = NOW()
           WHERE sprint_id = $1 AND task_id = $2`,
          [req.params.sprintId, assignment.task_id, outcome, task.status, Number(task.progress) || 0]
        );
        if (outcome === "carry_over") {
          await client.query("UPDATE research_board_tasks SET sprint_id = $2, cancelled_at = NULL, cancelled_by = NULL, updated_at = NOW() WHERE id = $1", [assignment.task_id, assignment.target_sprint_id]);
          await upsertSprintTaskAssignment({ taskId: assignment.task_id, sprintId: assignment.target_sprint_id, executor: client });
        } else if (outcome === "backlog") {
          await client.query("UPDATE research_board_tasks SET sprint_id = NULL, updated_at = NOW() WHERE id = $1", [assignment.task_id]);
        } else if (outcome === "cancelled") {
          await client.query("UPDATE research_board_tasks SET sprint_id = NULL, cancelled_at = NOW(), cancelled_by = $2, updated_at = NOW() WHERE id = $1", [assignment.task_id, access.userId || null]);
        }
      }
      const finalizedSummary = await client.query(
        `UPDATE research_sprint_summaries
         SET is_finalized = TRUE, finalized_by = $2, finalized_at = NOW(), updated_at = NOW()
         WHERE sprint_id = $1 AND is_finalized = FALSE RETURNING *`,
        [req.params.sprintId, access.userId || null]
      );
      if (finalizedSummary.rowCount === 0) throw createHttpError("Summary Sprint belum tersedia atau sudah difinalisasi.", 409, "SCRUM_SUMMARY_FINALIZED");
      await client.query("UPDATE research_sprints SET status = 'closed', closed_at = NOW(), updated_at = NOW() WHERE id = $1", [req.params.sprintId]);
      await client.query("COMMIT");
      res.json({ message: "Sprint berhasil difinalisasi.", sprintId: req.params.sprintId, status: "closed", summary: mapSprintSummary(finalizedSummary.rows[0]) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    if (extractRole(req) !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat membuat riset." });
    }

    const {
      id,
      title,
      shortTitle,
      supervisorLecturerId,
      periodText,
      mitra,
      status,
      progress,
      category,
      description,
      funding,
      repositori,
      attachmentLink
    } = req.body;

    if (!id || !title || !status) {
      return res.status(400).json({ message: "id, title, status wajib diisi." });
    }

    const documentFields = normalizeResearchDocumentFields(req.body);

    await query(
      `
      INSERT INTO research_projects (
        id, title, short_title, supervisor_lecturer_id, period_text,
        mitra, status, progress, category, description, funding, repositori, attachment_link,
        research_type, agreement_type, agreement_start_date,
        agreement_end_date, agreement_file_url, proposal_file_url, rab_file_url
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      `,
      [
        id,
        title,
        shortTitle || null,
        supervisorLecturerId || null,
        periodText || null,
        mitra || null,
        status,
        progress ?? 0,
        category || null,
        description || null,
        funding || null,
        repositori || null,
        attachmentLink || null,
        documentFields.researchType,
        documentFields.agreementType,
        documentFields.agreementStartDate,
        documentFields.agreementEndDate,
        documentFields.agreementFileUrl,
        documentFields.proposalFileUrl,
        documentFields.rabFileUrl
      ]
    );

    res.status(201).json({ message: "Riset berhasil ditambahkan." });
  })
);

router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    if (extractRole(req) !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat mengubah data riset." });
    }

    const { id } = req.params;
    const {
      title,
      shortTitle,
      supervisorLecturerId,
      periodText,
      mitra,
      status,
      progress,
      category,
      description,
      funding,
      repositori,
      attachmentLink
    } = req.body;

    const documentFields = normalizeResearchDocumentFields(req.body);

    const result = await query(
      `
      UPDATE research_projects
      SET title = COALESCE($2, title),
          short_title = COALESCE($3, short_title),
          supervisor_lecturer_id = COALESCE($4, supervisor_lecturer_id),
          period_text = COALESCE($5, period_text),
          mitra = COALESCE($6, mitra),
          status = COALESCE($7, status),
          progress = COALESCE($8, progress),
          category = COALESCE($9, category),
          description = COALESCE($10, description),
          funding = COALESCE($11, funding),
          repositori = COALESCE($12, repositori),
          attachment_link = COALESCE($13, attachment_link),
          research_type = COALESCE($14, research_type),
          agreement_type = COALESCE($15, agreement_type),
          agreement_start_date = COALESCE($16, agreement_start_date),
          agreement_end_date = COALESCE($17, agreement_end_date),
          agreement_file_url = COALESCE($18, agreement_file_url),
          proposal_file_url = COALESCE($19, proposal_file_url),
          rab_file_url = COALESCE($20, rab_file_url),
          updated_at = NOW()
      WHERE id = $1
      RETURNING id
      `,
      [
        id,
        title,
        shortTitle,
        supervisorLecturerId,
        periodText,
        mitra,
        status,
        progress,
        category,
        description,
        funding,
        repositori,
        attachmentLink !== undefined ? attachmentLink : null,
        documentFields.researchType,
        documentFields.agreementType,
        documentFields.agreementStartDate,
        documentFields.agreementEndDate,
        documentFields.agreementFileUrl,
        documentFields.proposalFileUrl,
        documentFields.rabFileUrl
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Riset tidak ditemukan." });
    }

    res.json({ message: "Data riset berhasil diperbarui." });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    if (extractRole(req) !== "operator") {
      return res.status(403).json({ message: "Hanya operator yang dapat menghapus riset." });
    }

    const result = await query("DELETE FROM research_projects WHERE id = $1 RETURNING id", [req.params.id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Riset tidak ditemukan." });
    }

    res.json({ message: "Riset berhasil dihapus." });
  })
);

router.post(
  "/:id/members",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (!["operator", "dosen"].includes(role)) {
      return res.status(403).json({ message: "Role tidak diizinkan menambah anggota riset." });
    }
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak menambah anggota di riset ini." });
    }

    const { userId, memberType, peran, status = "Aktif", bergabung } = req.body;

    if (!userId || !memberType) {
      return res.status(400).json({ message: "userId dan memberType wajib diisi." });
    }

    const ketuaConflictMessage = await ensureSingleKetuaPerScope({
      projectId: req.params.id,
      memberType,
      peran
    });
    if (ketuaConflictMessage) {
      return res.status(400).json({ message: ketuaConflictMessage });
    }

    const insertResult = await query(
      `
      INSERT INTO research_memberships (project_id, user_id, member_type, peran, status, bergabung)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (project_id, user_id)
      DO UPDATE SET member_type = EXCLUDED.member_type,
                    peran = EXCLUDED.peran,
                    status = EXCLUDED.status,
                    bergabung = EXCLUDED.bergabung
      RETURNING project_id, user_id, member_type, peran, status
      `,
      [req.params.id, userId, memberType, peran || null, status, bergabung || null]
    );

    res.status(201).json({ message: "Anggota riset berhasil disimpan." });
  })
);

router.patch(
  "/:id/members/:userId",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (!["operator", "dosen"].includes(role)) {
      return res.status(403).json({ message: "Role tidak diizinkan mengubah anggota riset." });
    }
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak mengubah anggota riset ini." });
    }

    const { memberType, peran, status, bergabung } = req.body;

    if (peran !== undefined || memberType !== undefined) {
      const existingMember = await query(
        "SELECT member_type, peran FROM research_memberships WHERE project_id = $1 AND user_id = $2 LIMIT 1",
        [req.params.id, req.params.userId]
      );
      const effectiveMemberType = memberType !== undefined
        ? memberType
        : existingMember.rows[0]?.member_type;
      const effectivePeran = peran !== undefined
        ? peran
        : existingMember.rows[0]?.peran;
      const ketuaConflictMessage = await ensureSingleKetuaPerScope({
        projectId: req.params.id,
        userIdToExclude: req.params.userId,
        memberType: effectiveMemberType,
        peran: effectivePeran
      });
      if (ketuaConflictMessage) {
        return res.status(400).json({ message: ketuaConflictMessage });
      }
    }

    const result = await query(
      `
      UPDATE research_memberships
      SET member_type = COALESCE($3, member_type),
          peran = COALESCE($4, peran),
          status = COALESCE($5, status),
          bergabung = COALESCE($6, bergabung)
      WHERE project_id = $1 AND user_id = $2
      RETURNING id
      `,
      [req.params.id, req.params.userId, memberType, peran, status, bergabung]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Anggota riset tidak ditemukan." });
    }

    res.json({ message: "Anggota riset berhasil diperbarui." });
  })
);

router.delete(
  "/:id/members/:userId",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (!["operator", "dosen"].includes(role)) {
      return res.status(403).json({ message: "Role tidak diizinkan menghapus anggota riset." });
    }
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak menghapus anggota riset ini." });
    }

    const result = await query(
      "DELETE FROM research_memberships WHERE project_id = $1 AND user_id = $2 RETURNING id",
      [req.params.id, req.params.userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Anggota riset tidak ditemukan." });
    }

    res.json({ message: "Anggota riset berhasil dihapus." });
  })
);

router.post(
  "/:id/join-requests",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (role !== "mahasiswa") {
      return res.status(403).json({ message: "Hanya mahasiswa yang dapat mengajukan permintaan join." });
    }
    const studentId = resolveRequesterUserId(req);

    await ensureResearchJoinRequestsTable();

    // Check if already active
    const memberCheck = await query(
      "SELECT status, peran FROM research_memberships WHERE project_id = $1 AND user_id = $2",
      [req.params.id, studentId]
    );

    if (memberCheck.rows.length > 0) {
      if (memberCheck.rows[0].status === 'Aktif' && memberCheck.rows[0].peran !== 'Alumni') {
        return res.status(400).json({ message: "Kamu sudah menjadi anggota aktif di riset ini." });
      }
    }

    await query(
      `
      INSERT INTO research_join_requests (project_id, student_id, status)
      VALUES ($1, $2, 'Menunggu')
      ON CONFLICT (project_id, student_id)
      DO UPDATE SET status = 'Menunggu', updated_at = NOW()
      `,
      [req.params.id, studentId]
    );

    // Send notifications to Dosen and Admins
    try {
      const projInfo = await query(
        `
        SELECT rp.title, l.user_id AS supervisor_user_id, u.name AS student_name
        FROM research_projects rp
        LEFT JOIN lecturers l ON l.id = rp.supervisor_lecturer_id
        LEFT JOIN users u ON u.id = $2
        WHERE rp.id = $1
        `,
        [req.params.id, studentId]
      );

      if (projInfo.rows.length > 0) {
        const p = projInfo.rows[0];
        const title = "Permintaan Join Kembali Riset";
        const body = `Mahasiswa ${p.student_name || 'Alumni'} meminta untuk bergabung kembali ke riset "${p.title}".`;

        const ops = await query("SELECT id FROM users WHERE role IN ('operator', 'admin')");
        const recipients = new Set(ops.rows.map(o => o.id));
        if (p.supervisor_user_id) recipients.add(p.supervisor_user_id);

        for (const recipientId of recipients) {
          await createNotification({
            id: `req-join-${req.params.id}-${studentId}-${Date.now()}-${recipientId}`,
            recipientUserId: recipientId,
            senderUserId: studentId,
            type: "pengumuman",
            title,
            body
          }).catch(err => console.error("Notif join request error:", err));
        }
      }
    } catch (err) {
      console.error("Error sending join request notifications:", err);
    }

    res.status(201).json({ message: "Permintaan join berhasil dikirim." });
  })
);

router.get(
  "/:id/join-requests",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (!["operator", "dosen"].includes(role)) {
      return res.status(403).json({ message: "Role tidak diizinkan." });
    }
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak." });
    }

    await ensureResearchJoinRequestsTable();

    const result = await query(
      `
      SELECT rjr.id, rjr.project_id, rjr.student_id, rjr.status, rjr.created_at,
             u.name AS student_name, s.nim
      FROM research_join_requests rjr
      JOIN users u ON u.id = rjr.student_id
      JOIN students s ON s.user_id = rjr.student_id
      WHERE rjr.project_id = $1 AND rjr.status = 'Menunggu'
      ORDER BY rjr.created_at ASC
      `,
      [req.params.id]
    );

    res.json(result.rows);
  })
);

router.patch(
  "/:id/join-requests/:requestId/approve",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (!["operator", "dosen"].includes(role)) {
      return res.status(403).json({ message: "Role tidak diizinkan." });
    }
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak." });
    }

    const { requestId } = req.params;

    const reqData = await query(
      "UPDATE research_join_requests SET status = 'Disetujui', updated_at = NOW() WHERE id = $1 RETURNING student_id",
      [requestId]
    );

    if (reqData.rows.length === 0) {
      return res.status(404).json({ message: "Permintaan tidak ditemukan." });
    }

    const studentId = reqData.rows[0].student_id;

    await query(
      `
      INSERT INTO research_memberships (project_id, user_id, member_type, peran, status, bergabung, selesai)
      VALUES ($1, $2, 'Mahasiswa', 'Mahasiswa', 'Aktif', CURRENT_DATE, NULL)
      ON CONFLICT (project_id, user_id)
      DO UPDATE SET status = 'Aktif', peran = 'Mahasiswa', selesai = NULL
      `,
      [req.params.id, studentId]
    );

    res.json({ message: "Permintaan disetujui." });
  })
);

router.patch(
  "/:id/join-requests/:requestId/reject",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (!["operator", "dosen"].includes(role)) {
      return res.status(403).json({ message: "Role tidak diizinkan." });
    }
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak." });
    }

    const { requestId } = req.params;

    const result = await query(
      "UPDATE research_join_requests SET status = 'Ditolak', updated_at = NOW() WHERE id = $1",
      [requestId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Permintaan tidak ditemukan." });
    }

    res.json({ message: "Permintaan ditolak." });
  })
);

router.post(
  "/:id/board-access",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (!["operator", "dosen"].includes(role)) {
      return res.status(403).json({ message: "Role tidak diizinkan memberi board access." });
    }
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak memberi board access di riset ini." });
    }

    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ message: "userId wajib diisi." });
    }

    await query(
      `
      INSERT INTO board_access (project_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT (project_id, user_id) DO NOTHING
      `,
      [req.params.id, userId]
    );

    res.status(201).json({ message: "Akses board berhasil diberikan." });
  })
);

router.delete(
  "/:id/board-access/:userId",
  asyncHandler(async (req, res) => {
    const role = extractRole(req);
    if (!["operator", "dosen"].includes(role)) {
      return res.status(403).json({ message: "Role tidak diizinkan mencabut board access." });
    }
    const allowed = await hasProjectAccess({ userId: resolveRequesterUserId(req), role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak mencabut board access di riset ini." });
    }

    const result = await query(
      "DELETE FROM board_access WHERE project_id = $1 AND user_id = $2 RETURNING id",
      [req.params.id, req.params.userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Akses board tidak ditemukan." });
    }

    res.json({ message: "Akses board berhasil dicabut." });
  })
);

router.post(
  "/:id/milestones",
  asyncHandler(async (req, res) => {
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    const actorUserId = access.userId || null;
    if (!access.isManager) {
      return res.status(403).json({
        message: "Akses ditolak. Anggota biasa hanya dapat mengisi card progress yang sudah tersedia."
      });
    }

    const { label, done = false, targetDate, sortOrder = 0 } = req.body;

    if (!label) {
      return res.status(400).json({ message: "label milestone wajib diisi." });
    }

    const result = await query(
      `
      INSERT INTO research_milestones (project_id, label, done, target_date, sort_order)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
      `,
      [req.params.id, label, done, targetDate || null, sortOrder]
    );

    await notifyMilestoneUpdate(req.params.id, actorUserId, "Menambahkan", label);

    res.status(201).json({ message: "Milestone berhasil ditambahkan.", id: result.rows[0].id });
  })
);

router.patch(
  "/:id/milestones/:milestoneId",
  asyncHandler(async (req, res) => {
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    const actorUserId = access.userId || null;
    if (!access.isManager) {
      return res.status(403).json({
        message: "Akses ditolak. Anggota biasa tidak dapat mengubah milestone."
      });
    }

    const { label, done, targetDate, sortOrder } = req.body;
    const existingMilestone = await query(
      `
      SELECT label
      FROM research_milestones
      WHERE project_id = $1 AND id = $2
      LIMIT 1
      `,
      [req.params.id, req.params.milestoneId]
    );

    const result = await query(
      `
      UPDATE research_milestones
      SET label = COALESCE($3, label),
          done = COALESCE($4, done),
          target_date = COALESCE($5, target_date),
          sort_order = COALESCE($6, sort_order)
      WHERE project_id = $1 AND id = $2
      RETURNING id
      `,
      [req.params.id, req.params.milestoneId, label, done, targetDate, sortOrder]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Milestone tidak ditemukan." });
    }

    await notifyMilestoneUpdate(
      req.params.id,
      actorUserId,
      "Memperbarui",
      String(label || existingMilestone.rows[0]?.label || "milestone").trim()
    );

    res.json({ message: "Milestone berhasil diperbarui." });
  })
);

router.delete(
  "/:id/milestones/:milestoneId",
  asyncHandler(async (req, res) => {
    const access = await getBoardAccessContext({ req, projectId: req.params.id });
    const actorUserId = access.userId || null;
    if (!access.isManager) {
      return res.status(403).json({
        message: "Akses ditolak. Anggota biasa tidak dapat menghapus milestone."
      });
    }

    const existingMilestone = await query(
      `
      SELECT label
      FROM research_milestones
      WHERE project_id = $1 AND id = $2
      LIMIT 1
      `,
      [req.params.id, req.params.milestoneId]
    );

    const result = await query(
      "DELETE FROM research_milestones WHERE project_id = $1 AND id = $2 RETURNING id",
      [req.params.id, req.params.milestoneId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Milestone tidak ditemukan." });
    }

    await notifyMilestoneUpdate(
      req.params.id,
      actorUserId,
      "Menghapus",
      String(existingMilestone.rows[0]?.label || "milestone").trim()
    );

    res.json({ message: "Milestone berhasil dihapus." });
  })
);

// ─── Meeting Notes ────────────────────────────────────────────────────────────

let ensureMeetingNotesTablesPromise = null;

async function ensureMeetingNotesTables() {
  if (!ensureMeetingNotesTablesPromise) {
    ensureMeetingNotesTablesPromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS research_meeting_notes (
          id                TEXT PRIMARY KEY,
          project_id        TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
          title             TEXT NOT NULL,
          meeting_date      DATE NOT NULL,
          location          TEXT,
          agenda            TEXT,
          content           TEXT NOT NULL,
          decisions         TEXT,
          next_meeting_date DATE,
          created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS research_meeting_attendees (
          id         BIGSERIAL PRIMARY KEY,
          meeting_id TEXT NOT NULL REFERENCES research_meeting_notes(id) ON DELETE CASCADE,
          user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
          name       TEXT NOT NULL,
          role_label TEXT,
          attended   BOOLEAN NOT NULL DEFAULT TRUE
        )
      `);
    })().catch((err) => {
      ensureMeetingNotesTablesPromise = null;
      throw err;
    });
  }
  return ensureMeetingNotesTablesPromise;
}

async function fetchMeetings(projectId, meetingId) {
  const params = [projectId];
  const meetingFilter = meetingId ? "AND m.id = $2" : "";
  if (meetingId) params.push(meetingId);

  const result = await query(
    `
    SELECT
      m.id,
      m.title,
      m.meeting_date,
      m.location,
      m.agenda,
      m.content,
      m.decisions,
      m.next_meeting_date,
      m.created_by,
      m.created_at,
      m.updated_at,
      COALESCE(
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'id',        a.id,
            'userId',    a.user_id,
            'name',      a.name,
            'roleLabel', a.role_label,
            'attended',  a.attended
          ) ORDER BY a.id
        ) FILTER (WHERE a.id IS NOT NULL),
        '[]'::json
      ) AS attendees,
      COUNT(a.id) FILTER (WHERE a.id IS NOT NULL)::int AS attendee_count
    FROM research_meeting_notes m
    LEFT JOIN research_meeting_attendees a ON a.meeting_id = m.id
    WHERE m.project_id = $1 ${meetingFilter}
    GROUP BY m.id
    ORDER BY m.meeting_date DESC, m.created_at DESC
    `,
    params
  );

  return result.rows.map((m) => ({
    id: m.id,
    title: m.title,
    meetingDate: m.meeting_date,
    location: m.location,
    agenda: m.agenda,
    content: m.content,
    decisions: m.decisions,
    nextMeetingDate: m.next_meeting_date,
    createdBy: m.created_by,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    attendees: m.attendees,
    attendeeCount: m.attendee_count
  }));
}

async function upsertAttendees(meetingId, attendees) {
  if (!Array.isArray(attendees) || attendees.length === 0) return;
  await query("DELETE FROM research_meeting_attendees WHERE meeting_id = $1", [meetingId]);
  for (const a of attendees) {
    const name = String(a.name || "").trim();
    if (!name) continue;
    await query(
      `INSERT INTO research_meeting_attendees (meeting_id, user_id, name, role_label, attended)
       VALUES ($1, $2, $3, $4, $5)`,
      [meetingId, a.userId || null, name, a.roleLabel ? String(a.roleLabel).trim() : null, a.attended !== false]
    );
  }
}

router.get(
  "/:id/meetings",
  asyncHandler(async (req, res) => {
    await ensureMeetingNotesTables();
    const role = extractRole(req);
    const userId = resolveRequesterUserId(req);
    const allowed = await hasProjectAccess({ userId, role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak melihat notulensi riset ini." });
    }
    const meetings = await fetchMeetings(req.params.id, null);
    res.json(meetings);
  })
);

router.post(
  "/:id/meetings",
  asyncHandler(async (req, res) => {
    await ensureMeetingNotesTables();
    const role = extractRole(req);
    const userId = resolveRequesterUserId(req);

    if (!["operator", "dosen"].includes(role)) {
      return res.status(403).json({ message: "Akses ditolak. Hanya operator atau dosen yang dapat membuat notulensi." });
    }
    const allowed = await hasProjectAccess({ userId, role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak membuat notulensi di riset ini." });
    }

    const { title, meetingDate, location, agenda, content, decisions, nextMeetingDate, attendees } = req.body;

    if (!title || !String(title).trim()) {
      return res.status(400).json({ message: "Judul notulensi wajib diisi." });
    }
    if (!meetingDate) {
      return res.status(400).json({ message: "Tanggal rapat wajib diisi." });
    }
    if (!content || !String(content).trim()) {
      return res.status(400).json({ message: "Isi notulensi wajib diisi." });
    }

    const id = buildEntityId("mtg");

    await query(
      `INSERT INTO research_meeting_notes
         (id, project_id, title, meeting_date, location, agenda, content, decisions, next_meeting_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        req.params.id,
        String(title).trim(),
        meetingDate,
        toNullableText(location),
        toNullableText(agenda),
        String(content).trim(),
        toNullableText(decisions),
        nextMeetingDate || null,
        userId || null
      ]
    );

    if (Array.isArray(attendees) && attendees.length > 0) {
      await upsertAttendees(id, attendees);
    }

    res.status(201).json({ message: "Notulensi berhasil dibuat.", id });
  })
);

router.get(
  "/:id/meetings/:meetingId",
  asyncHandler(async (req, res) => {
    await ensureMeetingNotesTables();
    const role = extractRole(req);
    const userId = resolveRequesterUserId(req);
    const allowed = await hasProjectAccess({ userId, role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak." });
    }
    const meetings = await fetchMeetings(req.params.id, req.params.meetingId);
    if (meetings.length === 0) {
      return res.status(404).json({ message: "Notulensi tidak ditemukan." });
    }
    res.json(meetings[0]);
  })
);

router.patch(
  "/:id/meetings/:meetingId",
  asyncHandler(async (req, res) => {
    await ensureMeetingNotesTables();
    const role = extractRole(req);
    const userId = resolveRequesterUserId(req);

    if (!["operator", "dosen"].includes(role)) {
      return res.status(403).json({ message: "Akses ditolak. Hanya operator atau dosen yang dapat mengedit notulensi." });
    }
    const allowed = await hasProjectAccess({ userId, role, projectId: req.params.id });
    if (!allowed) {
      return res.status(403).json({ message: "Akses ditolak mengedit notulensi di riset ini." });
    }

    const existing = await query(
      "SELECT id, created_by FROM research_meeting_notes WHERE project_id = $1 AND id = $2 LIMIT 1",
      [req.params.id, req.params.meetingId]
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ message: "Notulensi tidak ditemukan." });
    }
    if (role === "dosen" && existing.rows[0].created_by !== userId) {
      return res.status(403).json({ message: "Dosen hanya dapat mengedit notulensi yang dibuat sendiri." });
    }

    const { title, meetingDate, location, agenda, content, decisions, nextMeetingDate, attendees } = req.body;

    if (title !== undefined && !String(title).trim()) {
      return res.status(400).json({ message: "Judul tidak boleh kosong." });
    }
    if (content !== undefined && !String(content).trim()) {
      return res.status(400).json({ message: "Isi notulensi tidak boleh kosong." });
    }

    await query(
      `UPDATE research_meeting_notes
       SET title             = COALESCE($3, title),
           meeting_date      = COALESCE($4, meeting_date),
           location          = COALESCE($5, location),
           agenda            = COALESCE($6, agenda),
           content           = COALESCE($7, content),
           decisions         = COALESCE($8, decisions),
           next_meeting_date = COALESCE($9, next_meeting_date),
           updated_at        = NOW()
       WHERE project_id = $1 AND id = $2`,
      [
        req.params.id,
        req.params.meetingId,
        title !== undefined ? String(title).trim() : undefined,
        meetingDate !== undefined ? (meetingDate || null) : undefined,
        location !== undefined ? toNullableText(location) : undefined,
        agenda !== undefined ? toNullableText(agenda) : undefined,
        content !== undefined ? String(content).trim() : undefined,
        decisions !== undefined ? toNullableText(decisions) : undefined,
        nextMeetingDate !== undefined ? (nextMeetingDate || null) : undefined
      ]
    );

    if (Array.isArray(attendees)) {
      await upsertAttendees(req.params.meetingId, attendees);
    }

    res.json({ message: "Notulensi berhasil diperbarui." });
  })
);

router.delete(
  "/:id/meetings/:meetingId",
  asyncHandler(async (req, res) => {
    await ensureMeetingNotesTables();
    const role = extractRole(req);

    if (role !== "operator") {
      return res.status(403).json({ message: "Akses ditolak. Hanya operator yang dapat menghapus notulensi." });
    }

    const result = await query(
      "DELETE FROM research_meeting_notes WHERE project_id = $1 AND id = $2 RETURNING id",
      [req.params.id, req.params.meetingId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ message: "Notulensi tidak ditemukan." });
    }

    res.json({ message: "Notulensi berhasil dihapus." });
  })
);

module.exports = router;
