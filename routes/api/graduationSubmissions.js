const express = require("express");
const crypto = require("crypto");
const asyncHandler = require("../../utils/asyncHandler");
const { createNotification } = require("../../utils/notificationService");
const { pool, query } = require("../../db/pool");
const {
  ensureGraduationSubmissionsTables,
  getRequiredSpecialFieldsForRole,
  assertHttpUrl,
  mapSubmissionRow,
  mapSubmissionProjectRow
} = require("../../utils/graduationSubmissions");

const router = express.Router();

const COMMON_FIELD_LABELS = Object.freeze({
  reportUrl: "Link Laporan PA/Magang",
  productPhotoFolderUrl: "Link Folder kumpulan Foto Hasil Produk",
  manualBookUrl: "Link Manual Book",
  demoVideoUrl: "Link Video Demo Project"
});

async function notifyOperatorsGraduationSubmission({ student, projectRows, senderUserId }) {
  const operatorsResult = await query(
    "SELECT id FROM users WHERE role = 'operator' AND is_active = TRUE"
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
        eventId: "graduation_submission"
      }).catch(() => null)
    )
  );
}

function requireMahasiswa(req, res) {
  if (req.authUser?.role !== "mahasiswa") {
    res.status(403).json({ message: "Akses hanya untuk mahasiswa." });
    return false;
  }
  return true;
}

function requireOperator(req, res) {
  if (req.authUser?.role !== "operator") {
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
    repositoryUrl: "",
    repository_url: "",
    deployedUrl: "",
    deployed_url: "",
    datasetModelUrl: "",
    dataset_model_url: "",
    designDocumentationUrl: "",
    design_documentation_url: "",
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
      requiredSpecialFields: getRequiredSpecialFieldsForRole(activeMapped?.positionLabel || saved?.positionLabel),
      required_special_fields: getRequiredSpecialFieldsForRole(activeMapped?.positionLabel || saved?.positionLabel)
    };
  });

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
    canSubmit: projects.length > 0
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
      repositoryUrl: null,
      deployedUrl: null,
      datasetModelUrl: null,
      designDocumentationUrl: null
    };

    for (const key of ["repositoryUrl", "deployedUrl", "datasetModelUrl", "designDocumentationUrl"]) {
      const field = specialByKey.get(key);
      const value = getPayloadProjectValue(payload, key);
      row[key] = assertHttpUrl(value, field?.label || key, Boolean(field?.required));
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

router.get("/:id", asyncHandler(async (req, res) => {
  if (!requireOperator(req, res)) return;

  await ensureGraduationSubmissionsTables();

  const submissionId = String(req.params.id || "").trim();
  const result = await query(
    `
    ${graduationSubmissionListSelect}
    WHERE gs.id = $1
    LIMIT 1
    `,
    [submissionId]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ message: "Submit berkas kelulusan tidak ditemukan." });
  }

  const projectsResult = await query(
    `
    SELECT *
    FROM graduation_submission_projects
    WHERE submission_id = $1
    ORDER BY project_title ASC, project_id ASC
    `,
    [submissionId]
  );

  res.json({
    ...mapOperatorSubmissionRow(result.rows[0]),
    projects: projectsResult.rows.map(mapSubmissionProjectRow)
  });
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

    const [activeProjects, saved] = await Promise.all([
      getActiveGraduationProjects(req.authUser.id),
      getSavedSubmission(student.id)
    ]);
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
            report_url, product_photo_folder_url, manual_book_url, demo_video_url,
            repository_url, deployed_url, dataset_model_url, design_documentation_url
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          ON CONFLICT (submission_id, project_id)
          DO UPDATE SET project_title = EXCLUDED.project_title,
                        position_label = EXCLUDED.position_label,
                        report_url = EXCLUDED.report_url,
                        product_photo_folder_url = EXCLUDED.product_photo_folder_url,
                        manual_book_url = EXCLUDED.manual_book_url,
                        demo_video_url = EXCLUDED.demo_video_url,
                        repository_url = EXCLUDED.repository_url,
                        deployed_url = EXCLUDED.deployed_url,
                        dataset_model_url = EXCLUDED.dataset_model_url,
                        design_documentation_url = EXCLUDED.design_documentation_url,
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
            project.repositoryUrl,
            project.deployedUrl,
            project.datasetModelUrl,
            project.designDocumentationUrl
          ]
        );
      }

      if (student.status !== "Alumni") {
        await client.query(
          `
          UPDATE students
          SET status = 'Alumni',
              updated_at = NOW()
          WHERE id = $1
          `,
          [student.id]
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
            previous_status: student.status,
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
    const refreshedSaved = await getSavedSubmission(student.id);

    await notifyOperatorsGraduationSubmission({
      student: refreshedStudent || { ...student, status: "Alumni" },
      projectRows,
      senderUserId: req.authUser.id
    }).catch(() => null);

    res.status(201).json({
      message: "Berkas kelulusan berhasil dikirim. Status Anda sekarang Alumni dan akan diperiksa admin dalam 2-3 hari kerja.",
      ...buildProjectResponse({
        student: refreshedStudent || { ...student, status: "Alumni" },
        submission: refreshedSaved.submission,
        activeProjects: [],
        savedProjects: refreshedSaved.projects
      })
    });
  })
);

module.exports = router;
