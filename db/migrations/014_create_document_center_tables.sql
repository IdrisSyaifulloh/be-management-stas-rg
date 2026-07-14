BEGIN;

CREATE TABLE IF NOT EXISTS dc_document_definitions (
  id TEXT PRIMARY KEY,
  type_code TEXT NOT NULL,
  type_name TEXT NOT NULL,
  name TEXT NOT NULL,
  document_purpose TEXT NOT NULL,
  request_mode TEXT NOT NULL,
  activity_type TEXT,
  can_be_collective BOOLEAN NOT NULL DEFAULT FALSE,
  requires_project BOOLEAN NOT NULL DEFAULT FALSE,
  requires_period BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT dc_document_definitions_type_code_check
    CHECK (type_code ~ '^[0-9]{2}$'),
  CONSTRAINT dc_document_definitions_purpose_check
    CHECK (document_purpose IN (
      'introductory_letter',
      'acceptance_letter',
      'completion_letter',
      'certificate',
      'general'
    )),
  CONSTRAINT dc_document_definitions_request_mode_check
    CHECK (request_mode IN (
      'student_request',
      'operator_only',
      'alumni_sync',
      'early_exit_review'
    )),
  CONSTRAINT dc_document_definitions_activity_type_check
    CHECK (activity_type IS NULL OR activity_type IN ('Riset', 'Magang', 'general'))
);

CREATE INDEX IF NOT EXISTS idx_dc_document_definitions_type_active
  ON dc_document_definitions (type_code, is_active);

CREATE INDEX IF NOT EXISTS idx_dc_document_definitions_purpose_active
  ON dc_document_definitions (document_purpose, is_active);

CREATE TABLE IF NOT EXISTS dc_official_documents (
  id TEXT PRIMARY KEY,
  document_definition_id TEXT NOT NULL
    REFERENCES dc_document_definitions(id),
  source_request_id TEXT,
  generation_key TEXT,
  document_number TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  generated_from TEXT NOT NULL,
  activity_outcome TEXT,
  snapshot_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_version_number INTEGER,
  issued_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revocation_effective_date DATE,
  revocation_reason TEXT,
  revoked_by_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT dc_official_documents_status_check
    CHECK (status IN (
      'draft',
      'sedang_dibuat',
      'perlu_dilengkapi',
      'gagal_dibuat',
      'terbit',
      'diarsipkan',
      'dicabut'
    )),
  CONSTRAINT dc_official_documents_generated_from_check
    CHECK (generated_from IN (
      'operator_manual',
      'student_request',
      'alumni_sync',
      'early_exit_approved',
      'legacy_registration'
    )),
  CONSTRAINT dc_official_documents_activity_outcome_check
    CHECK (activity_outcome IS NULL OR activity_outcome IN (
      'completed',
      'withdrawn_early',
      'terminated_early'
    )),
  CONSTRAINT dc_official_documents_current_version_check
    CHECK (current_version_number IS NULL OR current_version_number > 0),
  CONSTRAINT dc_official_documents_issued_metadata_check
    CHECK (
      status NOT IN ('terbit', 'diarsipkan', 'dicabut')
      OR (
        document_number IS NOT NULL
        AND current_version_number IS NOT NULL
        AND issued_at IS NOT NULL
      )
    ),
  CONSTRAINT dc_official_documents_archived_metadata_check
    CHECK (status <> 'diarsipkan' OR archived_at IS NOT NULL),
  CONSTRAINT dc_official_documents_revocation_metadata_check
    CHECK (
      status <> 'dicabut'
      OR (
        revoked_at IS NOT NULL
        AND revocation_effective_date IS NOT NULL
        AND revocation_reason IS NOT NULL
        AND revoked_by_snapshot IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dc_official_documents_number
  ON dc_official_documents (document_number)
  WHERE document_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_dc_official_documents_generation_key
  ON dc_official_documents (generation_key)
  WHERE generation_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dc_official_documents_definition_status_issued
  ON dc_official_documents (document_definition_id, status, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_dc_official_documents_status_created
  ON dc_official_documents (status, created_at DESC);

CREATE TABLE IF NOT EXISTS dc_official_document_students (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL
    REFERENCES dc_official_documents(id) ON DELETE RESTRICT,
  student_key TEXT NOT NULL,
  legacy_student_id TEXT,
  legacy_project_id TEXT,
  legacy_period_key TEXT,
  project_key TEXT,
  name_snapshot TEXT NOT NULL,
  nim_snapshot TEXT NOT NULL,
  prodi_snapshot TEXT NOT NULL,
  university_snapshot TEXT,
  project_name_snapshot TEXT,
  period_snapshot TEXT,
  participant_role TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT dc_official_document_students_display_order_check
    CHECK (display_order >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dc_document_students_identity
  ON dc_official_document_students (
    document_id,
    student_key,
    COALESCE(project_key, ''),
    COALESCE(legacy_period_key, '')
  );

CREATE INDEX IF NOT EXISTS idx_dc_document_students_student_project_period
  ON dc_official_document_students (student_key, project_key, legacy_period_key);

CREATE INDEX IF NOT EXISTS idx_dc_document_students_legacy_student
  ON dc_official_document_students (legacy_student_id);

CREATE INDEX IF NOT EXISTS idx_dc_document_students_document
  ON dc_official_document_students (document_id);

CREATE TABLE IF NOT EXISTS dc_number_sequences (
  type_code TEXT NOT NULL,
  sequence_year INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (type_code, sequence_year),
  CONSTRAINT dc_number_sequences_type_code_check
    CHECK (type_code ~ '^[0-9]{2}$'),
  CONSTRAINT dc_number_sequences_last_sequence_check
    CHECK (last_sequence >= 0)
);

CREATE TABLE IF NOT EXISTS dc_document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL
    REFERENCES dc_official_documents(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  download_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  signer_snapshot JSONB,
  snapshot_data JSONB NOT NULL,
  version_reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT dc_document_versions_number_check
    CHECK (version_number > 0),
  CONSTRAINT dc_document_versions_file_size_check
    CHECK (file_size > 0),
  CONSTRAINT dc_document_versions_reason_check
    CHECK (version_reason IN (
      'initial_issue',
      'regenerate',
      'legacy_registration'
    )),
  CONSTRAINT dc_document_versions_document_version_unique
    UNIQUE (document_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_dc_document_versions_document_version
  ON dc_document_versions (document_id, version_number DESC);

CREATE INDEX IF NOT EXISTS idx_dc_document_versions_checksum
  ON dc_document_versions (checksum_sha256);

COMMIT;
