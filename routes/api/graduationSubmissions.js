const express = require("express");
const crypto = require("crypto");
const asyncHandler = require("../../utils/asyncHandler");
const { createNotification } = require("../../utils/notificationService");
const { pool, query } = require("../../db/pool");
const {
  ensureGraduationSubmissionsTables,
  getRequiredSpecialFieldsForRole,
  assertHttpUrl,
  normalizeFieldReviews,
  mapSubmissionRow,
  mapSubmissionProjectRow
} = require("../../utils/graduationSubmissions");

const router = express.Router();

const COMMON_FIELD_LABELS = Object.freeze({
  reportUrl: "Link Laporan PA/Magang",
  productPhotoFolderUrl: "Link Folder kumpulan Foto Hasil Produk",
  manualBookUrl: "Link Manual Book",
  demoVideoUrl: "Link Video Demo Project",
  githubUrl: "Link GitHub"
});

const SPECIAL_FIELD_LABELS = Object.freeze({
  repositoryUrl: "Link Repository GitHub / GitLab Proyek",
  deployedUrl: "Link Website Ter-deploy / Live",
  datasetModelUrl: "Link Dataset & Model Weights (.h5 / .pkl / dll)",
  designDocumentationUrl: "Link Master Desain & Dokumentasi Konten"
});

const REVIEWABLE_FIELD_KEYS = Object.freeze([
  "reportUrl",
  "productPhotoFolderUrl",
  "manualBookUrl",
  "demoVideoUrl",
  "githubUrl",
  "repositoryUrl",
  "deployedUrl",
  "datasetModelUrl",
  "designDocumentationUrl"
]);

const FIELD_TO_DB_COLUMN = Object.freeze({
  reportUrl: "report_url",
  productPhotoFolderUrl: "product_photo_folder_url",
  manualBookUrl: "manual_book_url",
  demoVideoUrl: "demo_video_url",
  githubUrl: "github_url",
  repositoryUrl: "repository_url",
  deployedUrl: "deployed_url",
  datasetModelUrl: "dataset_model_url",
  designDocumentationUrl: "design_documentation_url"
});

const REQUIRED_COMMON_REVIEW_FIELD_KEYS = Object.freeze([
  "reportUrl",
  "productPhotoFolderUrl",
  "manualBookUrl",
  "demoVideoUrl"
]);

function getFieldLabel(key) {
  return COMMON_FIELD_LABELS[key] || SPECIAL_FIELD_LABELS[key] || key;
}

async function notifyOperatorsGraduationSubmission({ student, projectRows, senderUserId }) {
  const operatorsResult = await query(
    "SELECT id FROM users WHERE role IN ('operator', 'admin') AND is_active = TRUE"
  );

  if (operatorsResult.rowCount === 0) return;

  const studentName = student?.name || student?.nim || "Mahasiswa";
  const projectNames = (projectRows || [])
    .map((item) => item.projectTitle || item.projectId)
    .filter(Boolean)
    .slice(0, 3)
    .join(", ");
  const suffix = projectNames ? ` untuk ${projectNames}` : "";

  await Promise.all(
    operatorsResult.rows.map((row) =>
      createNotification({
        recipientUserId: row.id,
        senderUserId,
        type: "kelulusan",
        title: "Berkas Kelulusan Baru",
        body: `${studentName} mengirim form berkas kelulusan${suffix}.`,
        eventId: `graduation_submission:${student?.id || senderUserId}:${Date.now()}`
      }).catch(() => null)
    )
  );
}

async function notifyStudentGraduation({ userId, senderUserId, title, body, eventId }) {
  if (!userId) return;

  await createNotification({
    recipientUserId: userId,
    senderUserId,
    type: "kelulusan",
    title,
    body,
    eventId: eventId || `graduation_review:${userId}:${Date.now()}`
  }).catch(() => null);
}

function requireMahasiswa(req, res) {
  if (req.authUser?.role !== "mahasiswa") {
    res.status(403).json({ message: "Akses hanya untuk mahasiswa." });
    return false;
  }
  return true;
}

function requireOperator(req, res) {
  if (!["operator", "admin"].includes(req.authUser?.role)) {
    res.status(403).json({ message: "Akses hanya untuk admin/operator." });
    return false;
  }
  return true;
}

async function getStudentByUserId(userId) {
  const result = await query(
    `
    SELECT s.id, s.user_id, s.nim, s.status, s.tipe, u.name
    FROM students s
    JOIN users u ON u.id = s.user_id
    WHERE s.user_id = $1
    LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] || null;
}

async function getActiveGraduationProjects(userId) {
  const result = await query(
    `
    SELECT rp.id AS project_id,
           COALESCE(rp.short_title, rp.title, rp.id) AS project_title,
           rp.title AS full_title,
           rm.peran AS position_label,
           rm.bergabung,
           rm.selesai
    FROM research_memberships rm
    JOIN research_projects rp ON rp.id = rm.project_id
    WHERE rm.user_id = $1
      AND rm.member_type = 'Mahasiswa'
      AND COALESCE(rm.status, 'Aktif') = 'Aktif'
      AND (rm.selesai IS NULL OR rm.selesai >= CURRENT_DATE)
    ORDER BY rp.title ASC, rp.id ASC
    LIMIT 100
    `,
    [userId]
  );

  return result.rows;
}

async function getSavedSubmission(studentId) {
  const submissionResult = await query(
    `
    SELECT *
    FROM graduation_submissions
    WHERE student_id = $1
    LIMIT 1
    `,
    [studentId]
  );

  const submission = submissionResult.rows[0] || null;

  if (!submission) {
    return { submission: null, projects: [] };
  }

  const projectsResult = await query(
    `
    SELECT *
    FROM graduation_submission_projects
    WHERE submission_id = $1
    ORDER BY project_title ASC, project_id ASC
    `,
    [submission.id]
  );

  return {
    submission,
    projects: projectsResult.rows
  };
}

function mapActiveProjectRow(row, studentId) {
  const specialFields = getRequiredSpecialFieldsForRole(row.position_label);

  return {
    id: null,
    studentId,
    student_id: studentId,
    projectId: row.project_id,
    project_id: row.project_id,
    projectTitle: row.project_title || row.full_title || row.project_id,
    project_title: row.project_title || row.full_title || row.project_id,
    positionLabel: row.position_label || "Anggota",
    position_label: row.position_label || "Anggota",
    reportUrl: "",
    report_url: "",
    productPhotoFolderUrl: "",
    product_photo_folder_url: "",
    manualBookUrl: "",
    manual_book_url: "",
    demoVideoUrl: "",
    demo_video_url: "",
    githubUrl: "",
    github_url: "",
    repositoryUrl: "",
    repository_url: "",
    deployedUrl: "",
    deployed_url: "",
    datasetModelUrl: "",
    dataset_model_url: "",
    designDocumentationUrl: "",
    design_documentation_url: "",
    fieldReviews: {},
    field_reviews: {},
    requiredSpecialFields: specialFields,
    required_special_fields: specialFields
  };
}

function buildProjectResponse({ student, submission, activeProjects, savedProjects }) {
  const activeById = new Map(activeProjects.map((item) => [item.project_id, item]));
  const savedMapped = savedProjects.map(mapSubmissionProjectRow);
  const savedById = new Map(savedMapped.map((item) => [item.projectId, item]));
  const combinedIds = Array.from(new Set([
    ...activeProjects.map((item) => item.project_id),
    ...savedMapped.map((item) => item.projectId)
  ]));

  const projects = combinedIds.map((projectId) => {
    const active = activeById.get(projectId);
    const saved = savedById.get(projectId);
    const activeMapped = active ? mapActiveProjectRow(active, student.id) : null;

    return {
      ...(activeMapped || saved || {}),
      ...(saved || {}),
      projectTitle: saved?.projectTitle || activeMapped?.projectTitle || projectId,
      project_title: saved?.project_title || activeMapped?.project_title || projectId,
      positionLabel: activeMapped?.positionLabel || saved?.positionLabel || "Anggota",
      position_label: activeMapped?.position_label || saved?.position_label || "Anggota",
      fieldReviews: saved?.fieldReviews || {},
      field_reviews: saved?.field_reviews || {},
      requiredSpecialFields: getRequiredSpecialFieldsForRole(activeMapped?.positionLabel || saved?.positionLabel),
      required_special_fields: getRequiredSpecialFieldsForRole(activeMapped?.positionLabel || saved?.positionLabel)
    };
  });

  const submissionStatus = submission?.status || "";

  return {
    student: {
      id: student.id,
      userId: student.user_id,
      user_id: student.user_id,
      nim: student.nim,
      name: student.name,
      status: student.status,
      studentStatus: student.status,
      tipe: student.tipe
    },
    submission: mapSubmissionRow(submission),
    projects,
    submitted: Boolean(submission?.submitted_at),
    graduationAllowed: Boolean(submission?.graduation_allowed_at),
    graduation_allowed: Boolean(submission?.graduation_allowed_at),
    canSubmit: projects.length > 0 && student.status !== "Alumni" && submissionStatus !== "Valid",
    canBecomeAlumni: student.status !== "Alumni" && submissionStatus === "Valid" && Boolean(submission?.graduation_allowed_at),
    can_become_alumni: student.status !== "Alumni" && submissionStatus === "Valid" && Boolean(submission?.graduation_allowed_at)
  };
}

function mapOperatorSubmissionRow(row) {
  const submission = mapSubmissionRow(row);

  return {
    ...submission,
    reviewedByName: row.reviewed_by_name || null,
    reviewed_by_name: row.reviewed_by_name || null,
    projectCount: Number(row.project_count || 0),
    project_count: Number(row.project_count || 0),
    projectSummary: row.project_summary || "",
    project_summary: row.project_summary || "",
    student: {
      id: row.student_id,
      userId: row.user_id,
      user_id: row.user_id,
      nim: row.nim,
      name: row.student_name,
      initials: row.student_initials,
      status: row.student_status,
      tipe: row.student_tipe
    }
  };
}

function getPayloadProjectValue(project, key) {
  const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return project?.[key] ?? project?.[snakeKey] ?? "";
}

function getProjectFieldValue(project, fieldKey) {
  const dbColumn = FIELD_TO_DB_COLUMN[fieldKey];
  return String(project?.[fieldKey] ?? project?.[dbColumn] ?? "").trim();
}

function normalizeOptionalDraftUrl(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  return assertHttpUrl(normalized, label, false);
}

function buildDraftProjectRows(payloadProjects, expectedProjects, savedProjects = []) {
  if (!Array.isArray(payloadProjects)) {
    const error = new Error("Data proyek wajib berupa array.");
    error.statusCode = 400;
    throw error;
  }

  const payloadByProject = new Map(
    payloadProjects
      .map((item) => [String(item?.projectId || item?.project_id || "").trim(), item])
      .filter(([projectId]) => projectId)
  );
  const savedByProject = new Map(
    savedProjects
      .map(mapSubmissionProjectRow)
      .map((item) => [String(item.projectId || item.project_id || "").trim(), item])
      .filter(([projectId]) => projectId)
  );

  return expectedProjects.map((project) => {
    const projectId = project.project_id || project.projectId;
    const payload = payloadByProject.get(projectId) || savedByProject.get(projectId) || {};
    const positionLabel = project.position_label || project.positionLabel || payload.positionLabel || payload.position_label || "Anggota";

    return {
      projectId,
      projectTitle: project.project_title || project.projectTitle || project.full_title || payload.projectTitle || payload.project_title || projectId,
      positionLabel,
      reportUrl: normalizeOptionalDraftUrl(getPayloadProjectValue(payload, "reportUrl"), COMMON_FIELD_LABELS.reportUrl),
      productPhotoFolderUrl: normalizeOptionalDraftUrl(getPayloadProjectValue(payload, "productPhotoFolderUrl"), COMMON_FIELD_LABELS.productPhotoFolderUrl),
      manualBookUrl: normalizeOptionalDraftUrl(getPayloadProjectValue(payload, "manualBookUrl"), COMMON_FIELD_LABELS.manualBookUrl),
      demoVideoUrl: normalizeOptionalDraftUrl(getPayloadProjectValue(payload, "demoVideoUrl"), COMMON_FIELD_LABELS.demoVideoUrl),
      githubUrl: normalizeOptionalDraftUrl(getPayloadProjectValue(payload, "githubUrl"), COMMON_FIELD_LABELS.githubUrl),
      repositoryUrl: normalizeOptionalDraftUrl(getPayloadProjectValue(payload, "repositoryUrl"), getFieldLabel("repositoryUrl")),
      deployedUrl: normalizeOptionalDraftUrl(getPayloadProjectValue(payload, "deployedUrl"), getFieldLabel("deployedUrl")),
      datasetModelUrl: normalizeOptionalDraftUrl(getPayloadProjectValue(payload, "datasetModelUrl"), getFieldLabel("datasetModelUrl")),
      designDocumentationUrl: normalizeOptionalDraftUrl(getPayloadProjectValue(payload, "designDocumentationUrl"), getFieldLabel("designDocumentationUrl"))
    };
  });
}

function removeReviewsForChangedFields(existingProject, nextProject) {
  const reviews = normalizeFieldReviews(existingProject?.field_reviews || existingProject?.fieldReviews);
  if (!existingProject || Object.keys(reviews).length === 0) return reviews;

  const nextReviews = { ...reviews };
  for (const key of REVIEWABLE_FIELD_KEYS) {
    const dbColumn = FIELD_TO_DB_COLUMN[key];
    const previousValue = String(existingProject?.[dbColumn] || "").trim();
    const nextValue = String(nextProject?.[key] || "").trim();
    if (previousValue !== nextValue) {
      delete nextReviews[key];
    }
  }

  return nextReviews;
}

function getRequiredReviewFieldsForProject(project) {
  const positionLabel = project?.position_label || project?.positionLabel || "Anggota";
  const requiredSpecialFields = getRequiredSpecialFieldsForRole(positionLabel);
  const keys = new Set(REQUIRED_COMMON_REVIEW_FIELD_KEYS);

  for (const field of requiredSpecialFields) {
    if (field?.key && field.required !== false) keys.add(field.key);
  }

  return REVIEWABLE_FIELD_KEYS.filter((key) => keys.has(key));
}

function getReviewableFieldsForProject(project) {
  const keys = new Set(getRequiredReviewFieldsForProject(project));

  for (const key of REVIEWABLE_FIELD_KEYS) {
    if (getProjectFieldValue(project, key)) keys.add(key);
  }

  return REVIEWABLE_FIELD_KEYS.filter((key) => keys.has(key) && getProjectFieldValue(project, key));
}

function computeSubmissionReviewStatus(projectRows) {
  const reviews = [];
  let hasMissingRequiredField = false;

  for (const project of projectRows || []) {
    const fieldReviews = normalizeFieldReviews(project.field_reviews || project.fieldReviews);
    const requiredKeys = getRequiredReviewFieldsForProject(project);

    for (const key of requiredKeys) {
      if (!getProjectFieldValue(project, key)) {
        hasMissingRequiredField = true;
        continue;
      }
      reviews.push(fieldReviews[key]?.status || "pending");
    }

    for (const key of getReviewableFieldsForProject(project)) {
      if (requiredKeys.includes(key)) continue;
      reviews.push(fieldReviews[key]?.status || "pending");
    }
  }

  if (reviews.some((status) => status === "rejected")) return "Revisi";
  if (hasMissingRequiredField || reviews.length === 0) return "Dikirim";
  if (reviews.every((status) => status === "accepted")) return "Valid";
  return "Dikirim";
}

function getGlobalReviewNote(status, fallbackNote) {
  if (status === "Valid") return "Semua link berkas kelulusan sudah ACC.";
  if (status === "Revisi") return fallbackNote || "Ada link berkas kelulusan yang perlu direvisi.";
  return null;
}

const graduationSubmissionListSelect = `
  SELECT gs.*,
         s.nim,
         s.status AS student_status,
         s.tipe AS student_tipe,
         u.name AS student_name,
         u.initials AS student_initials,
         ru.name AS reviewed_by_name,
         COALESCE(gp.project_count, 0)::int AS project_count,
         COALESCE(gp.project_summary, '') AS project_summary
  FROM graduation_submissions gs
  JOIN students s ON s.id = gs.student_id
  JOIN users u ON u.id = gs.user_id
  LEFT JOIN users ru ON ru.id = gs.reviewed_by
  LEFT JOIN (
    SELECT submission_id,
           COUNT(*)::int AS project_count,
           STRING_AGG(COALESCE(project_title, project_id), ', ' ORDER BY COALESCE(project_title, project_id)) AS project_summary
    FROM graduation_submission_projects
    GROUP BY submission_id
  ) gp ON gp.submission_id = gs.id
`;

async function getSubmissionDetailById(submissionId) {
  const result = await query(
    `
    ${graduationSubmissionListSelect}
    WHERE gs.id = $1
    LIMIT 1
    `,
    [submissionId]
  );

  if (result.rowCount === 0) return null;

  const projectsResult = await query(
    `
    SELECT *
    FROM graduation_submission_projects
    WHERE submission_id = $1
    ORDER BY project_title ASC, project_id ASC
    `,
    [submissionId]
  );

  return {
    ...mapOperatorSubmissionRow(result.rows[0]),
    projects: projectsResult.rows.map(mapSubmissionProjectRow)
  };
}

function validateSubmissionProjects(payloadProjects, expectedProjects) {
  if (!Array.isArray(payloadProjects)) {
    const error = new Error("Data proyek wajib berupa array.");
    error.statusCode = 400;
    throw error;
  }

  const payloadByProject = new Map(
    payloadProjects
      .map((item) => [String(item?.projectId || item?.project_id || "").trim(), item])
      .filter(([projectId]) => projectId)
  );

  const rows = [];

  for (const project of expectedProjects) {
    const projectId = project.project_id || project.projectId;
    const payload = payloadByProject.get(projectId);

    if (!payload) {
      const error = new Error(`Berkas untuk riset "${project.project_title || project.projectTitle || projectId}" wajib diisi.`);
      error.statusCode = 400;
      throw error;
    }

    const positionLabel = project.position_label || project.positionLabel || "Anggota";
    const specialFields = getRequiredSpecialFieldsForRole(positionLabel);
    const specialByKey = new Map(specialFields.map((item) => [item.key, item]));

    const row = {
      projectId,
      projectTitle: project.project_title || project.projectTitle || project.full_title || projectId,
      positionLabel,
      reportUrl: assertHttpUrl(getPayloadProjectValue(payload, "reportUrl"), COMMON_FIELD_LABELS.reportUrl),
      productPhotoFolderUrl: assertHttpUrl(getPayloadProjectValue(payload, "productPhotoFolderUrl"), COMMON_FIELD_LABELS.productPhotoFolderUrl),
      manualBookUrl: assertHttpUrl(getPayloadProjectValue(payload, "manualBookUrl"), COMMON_FIELD_LABELS.manualBookUrl),
      demoVideoUrl: assertHttpUrl(getPayloadProjectValue(payload, "demoVideoUrl"), COMMON_FIELD_LABELS.demoVideoUrl),
      githubUrl: assertHttpUrl(getPayloadProjectValue(payload, "githubUrl"), COMMON_FIELD_LABELS.githubUrl, false),
      repositoryUrl: null,
      deployedUrl: null,
      datasetModelUrl: null,
      designDocumentationUrl: null
    };

    for (const key of ["repositoryUrl", "deployedUrl", "datasetModelUrl", "designDocumentationUrl"]) {
      const field = specialByKey.get(key);
      const value = getPayloadProjectValue(payload, key);
      row[key] = assertHttpUrl(value, field?.label || getFieldLabel(key), Boolean(field?.required));
    }

    rows.push(row);
  }

  return rows;
}

router.get("/", asyncHandler(async (req, res) => {
  if (!requireOperator(req, res)) return;

  await ensureGraduationSubmissionsTables();

  const clauses = [];
  const params = [];
  const status = String(req.query.status || "").trim();
  const search = String(req.query.q || req.query.search || "").trim();

  if (status && status !== "Semua") {
    params.push(status);
    clauses.push(`gs.status = $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(u.name ILIKE $${params.length} OR s.nim ILIKE $${params.length} OR COALESCE(gp.project_summary, '') ILIKE $${params.length})`);
  }

  const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await query(
    `
    ${graduationSubmissionListSelect}
    ${whereClause}
    ORDER BY gs.submitted_at DESC NULLS LAST, gs.updated_at DESC
    LIMIT 300
    `,
    params
  );

  res.json(result.rows.map(mapOperatorSubmissionRow));
}));

router.get(
  "/me",
  asyncHandler(async (req, res) => {
    if (!requireMahasiswa(req, res)) return;

    await ensureGraduationSubmissionsTables();

    const student = await getStudentByUserId(req.authUser.id);
    if (!student) {
      return res.status(404).json({ message: "Data mahasiswa tidak ditemukan." });
    }

    const [activeProjects, saved] = await Promise.all([
      getActiveGraduationProjects(req.authUser.id),
      getSavedSubmission(student.id)
    ]);

    res.json(buildProjectResponse({
      student,
      submission: saved.submission,
      activeProjects,
      savedProjects: saved.projects
    }));
  })
);

router.patch("/:id/projects/:projectRowId/fields/:fieldKey/review", asyncHandler(async (req, res) => {
  if (!requireOperator(req, res)) return;

  await ensureGraduationSubmissionsTables();

  const submissionId = String(req.params.id || "").trim();
  const projectRowId = String(req.params.projectRowId || "").trim();
  const fieldKey = String(req.params.fieldKey || "").trim();
  const status = String(req.body?.status || "").trim();
  const note = String(req.body?.note || "").trim() || null;

  if (!REVIEWABLE_FIELD_KEYS.includes(fieldKey)) {
    return res.status(400).json({ message: "Field berkas tidak valid." });
  }

  if (!["accepted", "rejected"].includes(status)) {
    return res.status(400).json({ message: "Status review wajib accepted atau rejected." });
  }

  const client = await pool.connect();
  let projectForNotification = null;
  let nextSubmissionStatus = "Dikirim";

  try {
    await client.query("BEGIN");

    const projectResult = await client.query(
      `
      SELECT gp.*, gs.user_id AS submission_user_id, u.name AS student_name
      FROM graduation_submission_projects gp
      JOIN graduation_submissions gs ON gs.id = gp.submission_id
      JOIN users u ON u.id = gs.user_id
      WHERE gp.submission_id = $1
        AND gp.id = $2
      FOR UPDATE OF gp
      `,
      [submissionId, projectRowId]
    );

    if (projectResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Detail link berkas tidak ditemukan." });
    }

    const project = projectResult.rows[0];
    if (!getReviewableFieldsForProject(project).includes(fieldKey)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: `${getFieldLabel(fieldKey)} belum diisi mahasiswa.` });
    }

    const fieldReviews = normalizeFieldReviews(project.field_reviews);
    const reviewedAt = new Date().toISOString();
    const nextReviews = {
      ...fieldReviews,
      [fieldKey]: {
        status,
        note,
        reviewedBy: req.authUser.id,
        reviewedAt
      }
    };

    await client.query(
      `
      UPDATE graduation_submission_projects
      SET field_reviews = $3::jsonb,
          updated_at = NOW()
      WHERE submission_id = $1
        AND id = $2
      `,
      [submissionId, projectRowId, JSON.stringify(nextReviews)]
    );

    const projectsResult = await client.query(
      `
      SELECT *
      FROM graduation_submission_projects
      WHERE submission_id = $1
      ORDER BY project_title ASC, project_id ASC
      `,
      [submissionId]
    );

    nextSubmissionStatus = computeSubmissionReviewStatus(projectsResult.rows);
    const globalNote = getGlobalReviewNote(nextSubmissionStatus, status === "rejected" ? note || `${getFieldLabel(fieldKey)} ditolak.` : null);

    await client.query(
      `
      UPDATE graduation_submissions
      SET status = $2,
          reviewed_by = $3,
          reviewed_at = NOW(),
          review_note = $4,
          graduation_allowed_by = CASE WHEN $2 = 'Valid' THEN graduation_allowed_by ELSE NULL END,
          graduation_allowed_at = CASE WHEN $2 = 'Valid' THEN graduation_allowed_at ELSE NULL END,
          graduation_completed_by = CASE WHEN $2 = 'Valid' THEN graduation_completed_by ELSE NULL END,
          graduation_completed_at = CASE WHEN $2 = 'Valid' THEN graduation_completed_at ELSE NULL END,
          updated_at = NOW()
      WHERE id = $1
      `,
      [submissionId, nextSubmissionStatus, req.authUser.id, globalNote]
    );

    await client.query(
      `
      INSERT INTO audit_logs (id, user_id, user_role, action, target, detail)
      VALUES ($1, $2, 'Operator', 'Update', 'graduation_submission_review', $3)
      `,
      [
        `AUD-${crypto.randomUUID()}`,
        req.authUser.id,
        JSON.stringify({
          submission_id: submissionId,
          project_row_id: projectRowId,
          field_key: fieldKey,
          review_status: status,
          submission_status: nextSubmissionStatus
        })
      ]
    );

    await client.query("COMMIT");
    projectForNotification = project;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (projectForNotification) {
    const fieldLabel = getFieldLabel(fieldKey);
    if (status === "rejected") {
      await notifyStudentGraduation({
        userId: projectForNotification.submission_user_id,
        senderUserId: req.authUser.id,
        title: "Revisi Berkas Kelulusan",
        body: `${fieldLabel} pada ${projectForNotification.project_title || "riset"} ditolak admin. Silakan perbaiki lalu kirim ulang.`,
        eventId: `graduation_review:${submissionId}:${projectRowId}:${fieldKey}:rejected:${Date.now()}`
      });
    } else if (nextSubmissionStatus === "Valid") {
      await notifyStudentGraduation({
        userId: projectForNotification.submission_user_id,
        senderUserId: req.authUser.id,
        title: "Berkas Kelulusan Sudah ACC",
        body: "Semua link berkas kelulusan kamu sudah ACC. Tunggu admin memberi izin lulus agar tombol Alumni STAS-RG aktif.",
        eventId: `graduation_review:${submissionId}:valid:${Date.now()}`
      });
    }
  }

  const detail = await getSubmissionDetailById(submissionId);
  res.json(detail);
}));

router.post("/:id/allow-graduation", asyncHandler(async (req, res) => {
  if (!requireOperator(req, res)) return;

  await ensureGraduationSubmissionsTables();

  const submissionId = String(req.params.id || "").trim();
  const client = await pool.connect();
  let notificationUserId = null;

  try {
    await client.query("BEGIN");

    const submissionResult = await client.query(
      `
      SELECT gs.*, s.status AS student_status, u.name AS student_name
      FROM graduation_submissions gs
      JOIN students s ON s.id = gs.student_id
      JOIN users u ON u.id = gs.user_id
      WHERE gs.id = $1
      FOR UPDATE OF gs
      `,
      [submissionId]
    );

    if (submissionResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Submit berkas kelulusan tidak ditemukan." });
    }

    const submission = submissionResult.rows[0];
    if (submission.student_status === "Alumni") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Mahasiswa ini sudah Alumni STAS-RG." });
    }

    const projectsResult = await client.query(
      `
      SELECT *
      FROM graduation_submission_projects
      WHERE submission_id = $1
      ORDER BY project_title ASC, project_id ASC
      `,
      [submissionId]
    );

    const reviewStatus = computeSubmissionReviewStatus(projectsResult.rows);
    if (reviewStatus !== "Valid") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Semua link berkas harus ACC dulu sebelum mahasiswa diizinkan lulus." });
    }

    await client.query(
      `
      UPDATE graduation_submissions
      SET status = 'Valid',
          reviewed_by = $2,
          reviewed_at = NOW(),
          review_note = 'Semua link sudah ACC. Mahasiswa sudah diizinkan klik Jadi Alumni STAS-RG.',
          graduation_allowed_by = $2,
          graduation_allowed_at = COALESCE(graduation_allowed_at, NOW()),
          updated_at = NOW()
      WHERE id = $1
      `,
      [submissionId, req.authUser.id]
    );

    await client.query(
      `
      INSERT INTO audit_logs (id, user_id, user_role, action, target, detail)
      VALUES ($1, $2, 'Operator', 'Update', 'graduation_submission_allow', $3)
      `,
      [
        `AUD-${crypto.randomUUID()}`,
        req.authUser.id,
        JSON.stringify({
          student_id: submission.student_id,
          submission_id: submissionId,
          student_status: submission.student_status,
          graduation_allowed: true
        })
      ]
    );

    await client.query("COMMIT");
    notificationUserId = submission.user_id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await notifyStudentGraduation({
    userId: notificationUserId,
    senderUserId: req.authUser.id,
    title: "Berkas Kelulusan Sudah ACC",
    body: "Semua berkas kelulusan kamu sudah ACC dan admin sudah memberi izin lulus. Silakan klik tombol Jadi Alumni STAS-RG.",
    eventId: `graduation_allow:${submissionId}:${Date.now()}`
  });

  const detail = await getSubmissionDetailById(submissionId);
  res.json({
    message: "Akses lulus berhasil diberikan. Mahasiswa sekarang bisa klik Jadi Alumni STAS-RG.",
    ...detail
  });
}));

router.post("/me/draft", asyncHandler(async (req, res) => {
  if (!requireMahasiswa(req, res)) return;

  await ensureGraduationSubmissionsTables();

  const student = await getStudentByUserId(req.authUser.id);
  if (!student) {
    return res.status(404).json({ message: "Data mahasiswa tidak ditemukan." });
  }

  if (student.status === "Mengundurkan Diri") {
    return res.status(400).json({ message: "Mahasiswa yang mengundurkan diri tidak bisa menyimpan berkas kelulusan." });
  }

  if (student.status === "Alumni") {
    return res.status(400).json({ message: "Status Anda sudah Alumni STAS-RG." });
  }

  const [activeProjects, saved] = await Promise.all([
    getActiveGraduationProjects(req.authUser.id),
    getSavedSubmission(student.id)
  ]);

  if (saved.submission?.status === "Valid") {
    return res.status(400).json({ message: "Berkas sudah ACC semua. Form draft dikunci." });
  }

  const fallbackSavedProjects = saved.projects.map(mapSubmissionProjectRow);
  const expectedProjects = activeProjects.length > 0 ? activeProjects : fallbackSavedProjects;

  if (expectedProjects.length === 0) {
    return res.status(400).json({ message: "Belum ada riset/magang aktif untuk disimpan." });
  }

  const projectRows = buildDraftProjectRows(req.body?.projects || [], expectedProjects, saved.projects);
  const submissionId = saved.submission?.id || `GRD-${crypto.randomUUID()}`;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `
      INSERT INTO graduation_submissions (id, student_id, user_id, status, submitted_at)
      VALUES ($1, $2, $3, 'Draft', NULL)
      ON CONFLICT (student_id)
      DO UPDATE SET status = CASE
                        WHEN graduation_submissions.submitted_at IS NULL THEN 'Draft'
                        ELSE graduation_submissions.status
                      END,
                    updated_at = NOW()
      `,
      [submissionId, student.id, req.authUser.id]
    );

    await client.query(
      `
      DELETE FROM graduation_submission_projects
      WHERE submission_id = $1
        AND NOT (project_id = ANY($2::text[]))
      `,
      [submissionId, projectRows.map((item) => item.projectId)]
    );

    for (const project of projectRows) {
      const existingProjectResult = await client.query(
        `
        SELECT *
        FROM graduation_submission_projects
        WHERE submission_id = $1
          AND project_id = $2
        LIMIT 1
        `,
        [submissionId, project.projectId]
      );
      const nextReviews = removeReviewsForChangedFields(existingProjectResult.rows[0], project);

      await client.query(
        `
        INSERT INTO graduation_submission_projects (
          id, submission_id, student_id, project_id, project_title, position_label,
          report_url, product_photo_folder_url, manual_book_url, demo_video_url, github_url,
          repository_url, deployed_url, dataset_model_url, design_documentation_url, field_reviews
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
        ON CONFLICT (submission_id, project_id)
        DO UPDATE SET project_title = EXCLUDED.project_title,
                      position_label = EXCLUDED.position_label,
                      report_url = EXCLUDED.report_url,
                      product_photo_folder_url = EXCLUDED.product_photo_folder_url,
                      manual_book_url = EXCLUDED.manual_book_url,
                      demo_video_url = EXCLUDED.demo_video_url,
                      github_url = EXCLUDED.github_url,
                      repository_url = EXCLUDED.repository_url,
                      deployed_url = EXCLUDED.deployed_url,
                      dataset_model_url = EXCLUDED.dataset_model_url,
                      design_documentation_url = EXCLUDED.design_documentation_url,
                      field_reviews = EXCLUDED.field_reviews,
                      updated_at = NOW()
        `,
        [
          `GRDP-${crypto.randomUUID()}`,
          submissionId,
          student.id,
          project.projectId,
          project.projectTitle,
          project.positionLabel,
          project.reportUrl,
          project.productPhotoFolderUrl,
          project.manualBookUrl,
          project.demoVideoUrl,
          project.githubUrl,
          project.repositoryUrl,
          project.deployedUrl,
          project.datasetModelUrl,
          project.designDocumentationUrl,
          JSON.stringify(nextReviews)
        ]
      );
    }

    await client.query(
      `
      INSERT INTO audit_logs (id, user_id, user_role, action, target, detail)
      VALUES ($1, $2, 'Mahasiswa', 'Update', 'graduation_submission_draft', $3)
      `,
      [
        `AUD-${crypto.randomUUID()}`,
        req.authUser.id,
        JSON.stringify({
          student_id: student.id,
          submission_id: submissionId,
          project_ids: projectRows.map((item) => item.projectId),
          status: saved.submission?.status || "Draft"
        })
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const refreshedStudent = await getStudentByUserId(req.authUser.id);
  const refreshedSaved = await getSavedSubmission(student.id);

  res.json({
    message: "Draft berkas kelulusan berhasil disimpan. Admin sudah bisa melihat link yang tersimpan.",
    ...buildProjectResponse({
      student: refreshedStudent || student,
      submission: refreshedSaved.submission,
      activeProjects,
      savedProjects: refreshedSaved.projects
    })
  });
}));
router.post("/me/finalize-alumni", asyncHandler(async (req, res) => {
  if (!requireMahasiswa(req, res)) return;

  await ensureGraduationSubmissionsTables();

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const submissionResult = await client.query(
      `
      SELECT gs.*, s.status AS student_status, s.id AS student_id, s.user_id AS student_user_id
      FROM graduation_submissions gs
      JOIN students s ON s.id = gs.student_id
      WHERE gs.user_id = $1
      LIMIT 1
      FOR UPDATE OF gs, s
      `,
      [req.authUser.id]
    );

    if (submissionResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Submit berkas kelulusan tidak ditemukan." });
    }

    const submission = submissionResult.rows[0];
    if (submission.student_status === "Alumni") {
      await client.query("ROLLBACK");
      const refreshedStudent = await getStudentByUserId(req.authUser.id);
      const refreshedSaved = await getSavedSubmission(submission.student_id);
      return res.json({
        message: "Status Anda sudah Alumni STAS-RG.",
        ...buildProjectResponse({
          student: refreshedStudent,
          submission: refreshedSaved.submission,
          activeProjects: [],
          savedProjects: refreshedSaved.projects
        })
      });
    }

    if (!submission.graduation_allowed_at) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Admin belum memberi izin lulus. Tunggu sampai tombol Alumni STAS-RG diaktifkan." });
    }

    const projectsResult = await client.query(
      `
      SELECT *
      FROM graduation_submission_projects
      WHERE submission_id = $1
      ORDER BY project_title ASC, project_id ASC
      `,
      [submission.id]
    );

    const reviewStatus = computeSubmissionReviewStatus(projectsResult.rows);
    if (reviewStatus !== "Valid") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Semua link berkas harus ACC dulu sebelum menjadi Alumni STAS-RG." });
    }

    await client.query(
      `
      UPDATE students
      SET status = 'Alumni',
          updated_at = NOW()
      WHERE id = $1
      `,
      [submission.student_id]
    );

    await client.query(
      `
      UPDATE research_memberships
      SET status = 'Nonaktif',
          selesai = COALESCE(selesai, CURRENT_DATE)
      WHERE user_id = $1
        AND member_type = 'Mahasiswa'
        AND COALESCE(status, 'Aktif') = 'Aktif'
      `,
      [req.authUser.id]
    );

    await client.query(
      `
      UPDATE graduation_submissions
      SET status = 'Valid',
          graduation_completed_by = $2,
          graduation_completed_at = COALESCE(graduation_completed_at, NOW()),
          review_note = 'Mahasiswa sudah klik Jadi Alumni STAS-RG.',
          updated_at = NOW()
      WHERE id = $1
      `,
      [submission.id, req.authUser.id]
    );

    await client.query(
      `
      INSERT INTO audit_logs (id, user_id, user_role, action, target, detail)
      VALUES ($1, $2, 'Mahasiswa', 'Update', 'graduation_submission_self_finalize', $3)
      `,
      [
        `AUD-${crypto.randomUUID()}`,
        req.authUser.id,
        JSON.stringify({
          student_id: submission.student_id,
          submission_id: submission.id,
          previous_status: submission.student_status,
          new_status: "Alumni"
        })
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const refreshedStudent = await getStudentByUserId(req.authUser.id);
  const refreshedSaved = await getSavedSubmission(refreshedStudent.id);

  res.json({
    message: "Status Anda berhasil menjadi Alumni STAS-RG.",
    ...buildProjectResponse({
      student: refreshedStudent,
      submission: refreshedSaved.submission,
      activeProjects: [],
      savedProjects: refreshedSaved.projects
    })
  });
}));
router.get("/:id", asyncHandler(async (req, res) => {
  if (!requireOperator(req, res)) return;

  await ensureGraduationSubmissionsTables();

  const submissionId = String(req.params.id || "").trim();
  const detail = await getSubmissionDetailById(submissionId);

  if (!detail) {
    return res.status(404).json({ message: "Submit berkas kelulusan tidak ditemukan." });
  }

  res.json(detail);
}));

router.post(
  "/me",
  asyncHandler(async (req, res) => {
    if (!requireMahasiswa(req, res)) return;

    await ensureGraduationSubmissionsTables();

    const student = await getStudentByUserId(req.authUser.id);
    if (!student) {
      return res.status(404).json({ message: "Data mahasiswa tidak ditemukan." });
    }

    if (student.status === "Mengundurkan Diri") {
      return res.status(400).json({ message: "Mahasiswa yang mengundurkan diri tidak bisa submit berkas kelulusan." });
    }

    if (student.status === "Alumni") {
      return res.status(400).json({ message: "Status Anda sudah Alumni STAS-RG." });
    }

    const [activeProjects, saved] = await Promise.all([
      getActiveGraduationProjects(req.authUser.id),
      getSavedSubmission(student.id)
    ]);

    if (saved.submission?.status === "Valid") {
      return res.status(400).json({ message: "Berkas sudah ACC semua. Tunggu admin memberi izin lulus agar tombol Jadi Alumni STAS-RG aktif." });
    }

    const fallbackSavedProjects = saved.projects.map(mapSubmissionProjectRow);
    const expectedProjects = activeProjects.length > 0 ? activeProjects : fallbackSavedProjects;

    if (expectedProjects.length === 0) {
      return res.status(400).json({ message: "Belum ada riset/magang aktif untuk disubmit." });
    }

    const projectRows = validateSubmissionProjects(req.body?.projects, expectedProjects);
    const submissionId = saved.submission?.id || `GRD-${crypto.randomUUID()}`;

    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(
        `
        INSERT INTO graduation_submissions (id, student_id, user_id, status, submitted_at)
        VALUES ($1, $2, $3, 'Dikirim', NOW())
        ON CONFLICT (student_id)
        DO UPDATE SET status = 'Dikirim',
                      submitted_at = NOW(),
                      reviewed_by = NULL,
                      reviewed_at = NULL,
                      review_note = NULL,
                      graduation_allowed_by = NULL,
                      graduation_allowed_at = NULL,
                      graduation_completed_by = NULL,
                      graduation_completed_at = NULL,
                      updated_at = NOW()
        `,
        [submissionId, student.id, req.authUser.id]
      );

      await client.query(
        `
        DELETE FROM graduation_submission_projects
        WHERE submission_id = $1
          AND NOT (project_id = ANY($2::text[]))
        `,
        [submissionId, projectRows.map((item) => item.projectId)]
      );

      for (const project of projectRows) {
        await client.query(
          `
          INSERT INTO graduation_submission_projects (
            id, submission_id, student_id, project_id, project_title, position_label,
            report_url, product_photo_folder_url, manual_book_url, demo_video_url, github_url,
            repository_url, deployed_url, dataset_model_url, design_documentation_url, field_reviews
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, '{}'::jsonb)
          ON CONFLICT (submission_id, project_id)
          DO UPDATE SET project_title = EXCLUDED.project_title,
                        position_label = EXCLUDED.position_label,
                        report_url = EXCLUDED.report_url,
                        product_photo_folder_url = EXCLUDED.product_photo_folder_url,
                        manual_book_url = EXCLUDED.manual_book_url,
                        demo_video_url = EXCLUDED.demo_video_url,
                        github_url = EXCLUDED.github_url,
                        repository_url = EXCLUDED.repository_url,
                        deployed_url = EXCLUDED.deployed_url,
                        dataset_model_url = EXCLUDED.dataset_model_url,
                        design_documentation_url = EXCLUDED.design_documentation_url,
                        field_reviews = '{}'::jsonb,
                        updated_at = NOW()
          `,
          [
            `GRDP-${crypto.randomUUID()}`,
            submissionId,
            student.id,
            project.projectId,
            project.projectTitle,
            project.positionLabel,
            project.reportUrl,
            project.productPhotoFolderUrl,
            project.manualBookUrl,
            project.demoVideoUrl,
            project.githubUrl,
            project.repositoryUrl,
            project.deployedUrl,
            project.datasetModelUrl,
            project.designDocumentationUrl
          ]
        );
      }

      await client.query(
        `
        INSERT INTO audit_logs (id, user_id, user_role, action, target, detail)
        VALUES ($1, $2, 'Mahasiswa', 'Create', 'graduation_submission', $3)
        `,
        [
          `AUD-${crypto.randomUUID()}`,
          req.authUser.id,
          JSON.stringify({
            student_id: student.id,
            submission_id: submissionId,
            project_ids: projectRows.map((item) => item.projectId),
            previous_submission_status: saved.submission?.status || null,
            new_submission_status: "Dikirim",
            student_status: student.status
          })
        ]
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const refreshedStudent = await getStudentByUserId(req.authUser.id);
    const refreshedSaved = await getSavedSubmission(student.id);

    await notifyOperatorsGraduationSubmission({
      student: refreshedStudent || student,
      projectRows,
      senderUserId: req.authUser.id
    }).catch(() => null);

    res.status(201).json({
      message: "Berkas kelulusan berhasil dikirim. Admin akan memeriksa dan memberi ACC/Tolak pada setiap link.",
      ...buildProjectResponse({
        student: refreshedStudent || student,
        submission: refreshedSaved.submission,
        activeProjects,
        savedProjects: refreshedSaved.projects
      })
    });
  })
);

module.exports = router;



