BEGIN;

CREATE TABLE IF NOT EXISTS dc_document_requests (
  id TEXT PRIMARY KEY,
  document_definition_id TEXT NOT NULL
    REFERENCES dc_document_definitions(id) ON DELETE RESTRICT,
  student_key TEXT NOT NULL,
  legacy_student_id TEXT NOT NULL,
  student_snapshot JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  subject TEXT NOT NULL,
  student_note TEXT NULL,
  operator_note TEXT NULL,
  activity_type TEXT NULL,
  period_key TEXT NULL,
  period_snapshot JSONB NULL,
  legacy_project_id TEXT NULL,
  project_snapshot JSONB NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ NULL,
  reviewed_by_user_id TEXT NULL,
  cancelled_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  official_document_id TEXT NULL
    REFERENCES dc_official_documents(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT dc_document_requests_status_check CHECK (
    status IN ('submitted', 'revision_required', 'approved', 'rejected', 'cancelled', 'completed')
  ),
  CONSTRAINT dc_document_requests_student_key_check CHECK (
    student_key ~ '^student:[^[:space:]]+$'
  ),
  CONSTRAINT dc_document_requests_student_snapshot_check CHECK (
    jsonb_typeof(student_snapshot) = 'object'
  ),
  CONSTRAINT dc_document_requests_period_snapshot_check CHECK (
    period_snapshot IS NULL OR jsonb_typeof(period_snapshot) = 'object'
  ),
  CONSTRAINT dc_document_requests_project_snapshot_check CHECK (
    project_snapshot IS NULL OR jsonb_typeof(project_snapshot) = 'object'
  ),
  CONSTRAINT dc_document_requests_subject_check CHECK (
    subject = btrim(subject) AND char_length(subject) BETWEEN 1 AND 255
  ),
  CONSTRAINT dc_document_requests_activity_type_check CHECK (
    activity_type IS NULL OR activity_type IN ('Magang', 'Riset')
  ),
  CONSTRAINT dc_document_requests_reviewed_status_check CHECK (
    status NOT IN ('revision_required', 'approved', 'rejected')
    OR (reviewed_at IS NOT NULL AND reviewed_by_user_id IS NOT NULL)
  ),
  CONSTRAINT dc_document_requests_cancelled_at_check CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL)
    OR (status <> 'cancelled' AND cancelled_at IS NULL)
  ),
  CONSTRAINT dc_document_requests_completed_metadata_check CHECK (
    status <> 'completed' OR (completed_at IS NOT NULL AND official_document_id IS NOT NULL)
  ),
  CONSTRAINT dc_document_requests_official_document_status_check CHECK (
    official_document_id IS NULL OR status IN ('approved', 'completed')
  ),
  CONSTRAINT dc_document_requests_terminal_document_check CHECK (
    status NOT IN ('rejected', 'cancelled') OR official_document_id IS NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_dc_document_requests_student_created
  ON dc_document_requests (student_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dc_document_requests_status_created
  ON dc_document_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dc_document_requests_definition_status
  ON dc_document_requests (document_definition_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS dc_document_requests_active_context_unique
  ON dc_document_requests (
    student_key,
    document_definition_id,
    COALESCE(period_key, ''),
    COALESCE(legacy_project_id, '')
  )
  WHERE status IN ('submitted', 'revision_required', 'approved');

CREATE UNIQUE INDEX IF NOT EXISTS dc_document_requests_official_document_unique
  ON dc_document_requests (official_document_id)
  WHERE official_document_id IS NOT NULL;

COMMIT;
