const { query } = require("../db/pool");

const COMMON_GRADUATION_FIELDS = Object.freeze([
  "reportUrl",
  "productPhotoFolderUrl",
  "manualBookUrl",
  "demoVideoUrl"
]);

const SPECIAL_FIELD_DEFINITIONS = Object.freeze({
  repositoryUrl: {
    key: "repositoryUrl",
    dbColumn: "repository_url",
    label: "Link Repository GitHub / GitLab Proyek",
    required: true
  },
  deployedUrl: {
    key: "deployedUrl",
    dbColumn: "deployed_url",
    label: "Link Website Ter-deploy / Live",
    required: false
  },
  datasetModelUrl: {
    key: "datasetModelUrl",
    dbColumn: "dataset_model_url",
    label: "Link Dataset & Model Weights (.h5 / .pkl / dll)",
    required: true
  },
  designDocumentationUrl: {
    key: "designDocumentationUrl",
    dbColumn: "design_documentation_url",
    label: "Link Master Desain & Dokumentasi Konten",
    required: true
  }
});

let ensureGraduationSubmissionsPromise = null;

async function ensureGraduationSubmissionsTables() {
  if (!ensureGraduationSubmissionsPromise) {
    ensureGraduationSubmissionsPromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS graduation_submissions (
          id TEXT PRIMARY KEY,
          student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'Dikirim'
            CHECK (status IN ('Draft', 'Dikirim', 'Valid', 'Revisi')),
          submitted_at TIMESTAMPTZ,
          reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          reviewed_at TIMESTAMPTZ,
          review_note TEXT,
          graduation_allowed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          graduation_allowed_at TIMESTAMPTZ,
          graduation_completed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          graduation_completed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (student_id)
        );

        CREATE TABLE IF NOT EXISTS graduation_submission_projects (
          id TEXT PRIMARY KEY,
          submission_id TEXT NOT NULL REFERENCES graduation_submissions(id) ON DELETE CASCADE,
          student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
          project_title TEXT,
          position_label TEXT,
          report_url TEXT NOT NULL,
          product_photo_folder_url TEXT NOT NULL,
          manual_book_url TEXT NOT NULL,
          demo_video_url TEXT NOT NULL,
          repository_url TEXT,
          deployed_url TEXT,
          dataset_model_url TEXT,
          design_documentation_url TEXT,
          field_reviews JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (submission_id, project_id)
        );
      `);

      await query(`
        ALTER TABLE graduation_submissions
          ADD COLUMN IF NOT EXISTS student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
          ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
          ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'Dikirim',
          ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS review_note TEXT,
          ADD COLUMN IF NOT EXISTS graduation_allowed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          ADD COLUMN IF NOT EXISTS graduation_allowed_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS graduation_completed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          ADD COLUMN IF NOT EXISTS graduation_completed_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

        ALTER TABLE graduation_submission_projects
          ADD COLUMN IF NOT EXISTS submission_id TEXT REFERENCES graduation_submissions(id) ON DELETE CASCADE,
          ADD COLUMN IF NOT EXISTS student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
          ADD COLUMN IF NOT EXISTS project_id TEXT REFERENCES research_projects(id) ON DELETE CASCADE,
          ADD COLUMN IF NOT EXISTS project_title TEXT,
          ADD COLUMN IF NOT EXISTS position_label TEXT,
          ADD COLUMN IF NOT EXISTS report_url TEXT,
          ADD COLUMN IF NOT EXISTS product_photo_folder_url TEXT,
          ADD COLUMN IF NOT EXISTS manual_book_url TEXT,
          ADD COLUMN IF NOT EXISTS demo_video_url TEXT,
          ADD COLUMN IF NOT EXISTS repository_url TEXT,
          ADD COLUMN IF NOT EXISTS deployed_url TEXT,
          ADD COLUMN IF NOT EXISTS dataset_model_url TEXT,
          ADD COLUMN IF NOT EXISTS design_documentation_url TEXT,
          ADD COLUMN IF NOT EXISTS field_reviews JSONB NOT NULL DEFAULT '{}'::jsonb,
          ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      `);

      await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_graduation_submissions_student_unique
          ON graduation_submissions(student_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_graduation_submission_projects_submission_project_unique
          ON graduation_submission_projects(submission_id, project_id);
        CREATE INDEX IF NOT EXISTS idx_graduation_submissions_student
          ON graduation_submissions(student_id, submitted_at DESC);
        CREATE INDEX IF NOT EXISTS idx_graduation_submission_projects_student
          ON graduation_submission_projects(student_id, project_id);
      `);
    })().catch((error) => {
      ensureGraduationSubmissionsPromise = null;
      throw error;
    });
  }

  await ensureGraduationSubmissionsPromise;
}
function normalizeRole(value) {
  return String(value || "").trim().toLowerCase();
}

function getRequiredSpecialFieldsForRole(roleValue) {
  const role = normalizeRole(roleValue);
  const fields = [];

  const isCodeRole =
    /web|frontend|front-end|backend|back-end|fullstack|full-stack|programmer|developer|dev|engineer|qa|quality|iot|hardware|data science|data scientist|data analyst|machine|learning|\bml\b/.test(role);
  const isWebOrQaRole = /web|frontend|front-end|backend|back-end|fullstack|full-stack|programmer|developer|dev|qa|quality/.test(role);
  const isDataOrMlRole = /data science|data scientist|data analyst|machine|learning|\bml\b/.test(role);
  const isCreativeRole = /sosial|social|media|creative|content|desain|design|canva|figma/.test(role);

  if (isCodeRole) fields.push(SPECIAL_FIELD_DEFINITIONS.repositoryUrl);
  if (isWebOrQaRole) fields.push(SPECIAL_FIELD_DEFINITIONS.deployedUrl);
  if (isDataOrMlRole) fields.push(SPECIAL_FIELD_DEFINITIONS.datasetModelUrl);
  if (isCreativeRole) fields.push(SPECIAL_FIELD_DEFINITIONS.designDocumentationUrl);

  return fields;
}

function trimToNull(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function assertHttpUrl(value, label, required = true) {
  const normalized = trimToNull(value);

  if (!normalized) {
    if (!required) return null;
    const error = new Error(`${label} wajib diisi.`);
    error.statusCode = 400;
    throw error;
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("invalid protocol");
    }
  } catch {
    const error = new Error(`${label} wajib berupa URL valid yang diawali http:// atau https://.`);
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function mapSubmissionRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    studentId: row.student_id,
    student_id: row.student_id,
    userId: row.user_id,
    user_id: row.user_id,
    status: row.status,
    submittedAt: row.submitted_at,
    submitted_at: row.submitted_at,
    reviewedBy: row.reviewed_by,
    reviewed_by: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewed_at: row.reviewed_at,
    reviewNote: row.review_note,
    review_note: row.review_note,
    graduationAllowedBy: row.graduation_allowed_by,
    graduation_allowed_by: row.graduation_allowed_by,
    graduationAllowedAt: row.graduation_allowed_at,
    graduation_allowed_at: row.graduation_allowed_at,
    graduationCompletedBy: row.graduation_completed_by,
    graduation_completed_by: row.graduation_completed_by,
    graduationCompletedAt: row.graduation_completed_at,
    graduation_completed_at: row.graduation_completed_at,
    createdAt: row.created_at,
    created_at: row.created_at,
    updatedAt: row.updated_at,
    updated_at: row.updated_at
  };
}

function normalizeFieldReviews(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function mapSubmissionProjectRow(row) {
  const specialFields = getRequiredSpecialFieldsForRole(row.position_label);
  const fieldReviews = normalizeFieldReviews(row.field_reviews);

  return {
    id: row.id,
    submissionId: row.submission_id,
    submission_id: row.submission_id,
    studentId: row.student_id,
    student_id: row.student_id,
    projectId: row.project_id,
    project_id: row.project_id,
    projectTitle: row.project_title,
    project_title: row.project_title,
    positionLabel: row.position_label,
    position_label: row.position_label,
    reportUrl: row.report_url || "",
    report_url: row.report_url || "",
    productPhotoFolderUrl: row.product_photo_folder_url || "",
    product_photo_folder_url: row.product_photo_folder_url || "",
    manualBookUrl: row.manual_book_url || "",
    manual_book_url: row.manual_book_url || "",
    demoVideoUrl: row.demo_video_url || "",
    demo_video_url: row.demo_video_url || "",
    repositoryUrl: row.repository_url || "",
    repository_url: row.repository_url || "",
    deployedUrl: row.deployed_url || "",
    deployed_url: row.deployed_url || "",
    datasetModelUrl: row.dataset_model_url || "",
    dataset_model_url: row.dataset_model_url || "",
    designDocumentationUrl: row.design_documentation_url || "",
    design_documentation_url: row.design_documentation_url || "",
    fieldReviews,
    field_reviews: fieldReviews,
    requiredSpecialFields: specialFields,
    required_special_fields: specialFields
  };
}

module.exports = {
  COMMON_GRADUATION_FIELDS,
  SPECIAL_FIELD_DEFINITIONS,
  ensureGraduationSubmissionsTables,
  getRequiredSpecialFieldsForRole,
  assertHttpUrl,
  normalizeFieldReviews,
  mapSubmissionRow,
  mapSubmissionProjectRow
};


