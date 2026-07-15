BEGIN;

CREATE TABLE IF NOT EXISTS dc_document_templates (
  id TEXT PRIMARY KEY,
  document_definition_id TEXT NOT NULL
    REFERENCES dc_document_definitions(id) ON DELETE RESTRICT,
  template_key TEXT NOT NULL,
  name TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  activity_outcome TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  layout_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  active_version_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT dc_document_templates_key_check
    CHECK (template_key IN ('certificate_completed_internship', 'certificate_completed_research')),
  CONSTRAINT dc_document_templates_activity_type_check
    CHECK (activity_type IN ('Magang', 'Riset')),
  CONSTRAINT dc_document_templates_activity_outcome_check
    CHECK (activity_outcome = 'completed'),
  CONSTRAINT dc_document_templates_status_check
    CHECK (status IN ('draft', 'active', 'inactive')),
  CONSTRAINT dc_document_templates_layout_config_check
    CHECK (jsonb_typeof(layout_config) = 'object'),
  CONSTRAINT dc_document_templates_content_config_check
    CHECK (jsonb_typeof(content_config) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dc_document_templates_key
  ON dc_document_templates (template_key);

CREATE INDEX IF NOT EXISTS idx_dc_document_templates_definition
  ON dc_document_templates (document_definition_id, activity_type, activity_outcome, status);

CREATE TABLE IF NOT EXISTS dc_document_template_versions (
  id TEXT PRIMARY KEY,
  document_template_id TEXT NOT NULL
    REFERENCES dc_document_templates(id) ON DELETE RESTRICT,
  version_number INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  page_width NUMERIC(10,2) NOT NULL,
  page_height NUMERIC(10,2) NOT NULL,
  layout_config JSONB NOT NULL,
  content_config JSONB NOT NULL,
  created_by_user_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT dc_document_template_versions_version_check
    CHECK (version_number > 0),
  CONSTRAINT dc_document_template_versions_mime_type_check
    CHECK (mime_type = 'application/pdf'),
  CONSTRAINT dc_document_template_versions_file_size_check
    CHECK (file_size > 0),
  CONSTRAINT dc_document_template_versions_checksum_check
    CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT dc_document_template_versions_page_check
    CHECK (page_width = 842.25 AND page_height = 595.50),
  CONSTRAINT dc_document_template_versions_layout_config_check
    CHECK (jsonb_typeof(layout_config) = 'object'),
  CONSTRAINT dc_document_template_versions_content_config_check
    CHECK (jsonb_typeof(content_config) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dc_document_template_versions_number
  ON dc_document_template_versions (document_template_id, version_number);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dc_document_template_versions_storage_key
  ON dc_document_template_versions (storage_key);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'dc_document_templates_active_version_fk'
      AND conrelid = 'dc_document_templates'::regclass
  ) THEN
    ALTER TABLE dc_document_templates
      ADD CONSTRAINT dc_document_templates_active_version_fk
      FOREIGN KEY (active_version_id)
      REFERENCES dc_document_template_versions(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

ALTER TABLE dc_document_versions
  ADD COLUMN IF NOT EXISTS template_version_id TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'dc_document_versions_template_version_fk'
      AND conrelid = 'dc_document_versions'::regclass
  ) THEN
    ALTER TABLE dc_document_versions
      ADD CONSTRAINT dc_document_versions_template_version_fk
      FOREIGN KEY (template_version_id)
      REFERENCES dc_document_template_versions(id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'dc_document_versions_reason_check'
      AND conrelid = 'dc_document_versions'::regclass
  ) THEN
    ALTER TABLE dc_document_versions
      DROP CONSTRAINT dc_document_versions_reason_check;
  END IF;

  ALTER TABLE dc_document_versions
    ADD CONSTRAINT dc_document_versions_reason_check
    CHECK (
      version_reason IN (
        'initial_issue',
        'regenerate',
        'legacy_registration',
        'publish_final'
      )
    );
END
$$;

INSERT INTO dc_document_templates (
  id,
  document_definition_id,
  template_key,
  name,
  activity_type,
  activity_outcome,
  status,
  layout_config,
  content_config
)
VALUES
  (
    'DCTPL-CERT-COMPLETE-MAGANG-01',
    'DCDEF-CERT-NORMAL-01',
    'certificate_completed_internship',
    'Sertifikat Magang Selesai',
    'Magang',
    'completed',
    'draft',
    '{}'::jsonb,
    '{}'::jsonb
  ),
  (
    'DCTPL-CERT-COMPLETE-RISET-01',
    'DCDEF-CERT-NORMAL-01',
    'certificate_completed_research',
    'Sertifikat Riset Selesai',
    'Riset',
    'completed',
    'draft',
    '{}'::jsonb,
    '{}'::jsonb
  )
ON CONFLICT (id) DO NOTHING;

COMMIT;
