BEGIN;

CREATE TABLE IF NOT EXISTS dc_final_activity_cases (
  id TEXT PRIMARY KEY,
  student_key TEXT NOT NULL,
  legacy_student_id TEXT NULL,
  student_snapshot JSONB NOT NULL,
  activity_type TEXT NOT NULL,
  period_key TEXT NOT NULL,
  legacy_period_id TEXT NULL,
  period_snapshot JSONB NOT NULL,
  outcome TEXT NOT NULL,
  case_status TEXT NOT NULL DEFAULT 'pending',
  completion_source TEXT NOT NULL,
  completed_at DATE NOT NULL,
  completion_snapshot JSONB NOT NULL,
  completion_document_definition_id TEXT NOT NULL
    REFERENCES dc_document_definitions(id) ON DELETE RESTRICT,
  completion_document_id TEXT NULL
    REFERENCES dc_official_documents(id) ON DELETE RESTRICT,
  created_by_user_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT dc_final_activity_cases_student_key_check
    CHECK (student_key ~ '^student:[^[:space:]]+$'),
  CONSTRAINT dc_final_activity_cases_activity_type_check
    CHECK (activity_type IN ('Magang', 'Riset')),
  CONSTRAINT dc_final_activity_cases_outcome_check
    CHECK (outcome IN ('completed', 'withdrawn_early', 'terminated_early')),
  CONSTRAINT dc_final_activity_cases_status_check
    CHECK (case_status IN ('pending', 'draft_created', 'issued', 'revoked')),
  CONSTRAINT dc_final_activity_cases_student_snapshot_check
    CHECK (jsonb_typeof(student_snapshot) = 'object'),
  CONSTRAINT dc_final_activity_cases_period_snapshot_check
    CHECK (jsonb_typeof(period_snapshot) = 'object'),
  CONSTRAINT dc_final_activity_cases_completion_snapshot_check
    CHECK (jsonb_typeof(completion_snapshot) = 'object'),
  CONSTRAINT dc_final_activity_cases_completed_at_check
    CHECK (outcome <> 'completed' OR completed_at IS NOT NULL),
  CONSTRAINT dc_final_activity_cases_completion_document_status_check
    CHECK (
      (completion_document_id IS NULL AND case_status = 'pending')
      OR (completion_document_id IS NOT NULL AND case_status IN ('draft_created', 'issued', 'revoked'))
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dc_final_activity_cases_identity
  ON dc_final_activity_cases (
    student_key,
    completion_document_definition_id,
    activity_type,
    period_key,
    outcome
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_dc_final_activity_cases_completion_document
  ON dc_final_activity_cases (completion_document_id)
  WHERE completion_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dc_final_activity_cases_status_created
  ON dc_final_activity_cases (case_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dc_final_activity_cases_student
  ON dc_final_activity_cases (student_key, created_at DESC);

CREATE TABLE IF NOT EXISTS dc_final_activity_case_projects (
  id TEXT PRIMARY KEY,
  final_activity_case_id TEXT NOT NULL
    REFERENCES dc_final_activity_cases(id) ON DELETE RESTRICT,
  student_key TEXT NOT NULL,
  project_key TEXT NOT NULL,
  legacy_project_id TEXT NULL,
  project_snapshot JSONB NOT NULL,
  certificate_required BOOLEAN NOT NULL DEFAULT TRUE,
  certificate_document_definition_id TEXT NULL
    REFERENCES dc_document_definitions(id) ON DELETE RESTRICT,
  certificate_document_id TEXT NULL
    REFERENCES dc_official_documents(id) ON DELETE RESTRICT,
  certificate_status TEXT NOT NULL DEFAULT 'pending',
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT dc_final_activity_case_projects_student_key_check
    CHECK (student_key ~ '^student:[^[:space:]]+$'),
  CONSTRAINT dc_final_activity_case_projects_project_key_check
    CHECK (project_key ~ '^project:[^[:space:]]+$'),
  CONSTRAINT dc_final_activity_case_projects_status_check
    CHECK (certificate_status IN ('pending', 'draft_created', 'issued', 'revoked')),
  CONSTRAINT dc_final_activity_case_projects_display_order_check
    CHECK (display_order >= 0),
  CONSTRAINT dc_final_activity_case_projects_snapshot_check
    CHECK (jsonb_typeof(project_snapshot) = 'object'),
  CONSTRAINT dc_final_activity_case_projects_document_status_check
    CHECK (
      (certificate_document_id IS NULL AND certificate_status = 'pending')
      OR (certificate_document_id IS NOT NULL AND certificate_status IN ('draft_created', 'issued', 'revoked'))
    ),
  CONSTRAINT dc_final_activity_case_projects_certificate_definition_check
    CHECK (
      certificate_document_definition_id IS NOT NULL
      OR certificate_required = FALSE
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dc_final_activity_case_projects_case_project
  ON dc_final_activity_case_projects (final_activity_case_id, project_key);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dc_final_activity_case_projects_student_project_definition
  ON dc_final_activity_case_projects (
    student_key,
    project_key,
    certificate_document_definition_id
  )
  WHERE certificate_required = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_dc_final_activity_case_projects_certificate_document
  ON dc_final_activity_case_projects (certificate_document_id)
  WHERE certificate_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dc_final_activity_case_projects_case
  ON dc_final_activity_case_projects (final_activity_case_id, display_order);

CREATE INDEX IF NOT EXISTS idx_dc_final_activity_case_projects_status
  ON dc_final_activity_case_projects (certificate_status, created_at DESC);

COMMIT;
