BEGIN;

ALTER TABLE dc_document_templates
  DROP CONSTRAINT IF EXISTS dc_document_templates_key_check;

ALTER TABLE dc_document_templates
  ADD CONSTRAINT dc_document_templates_key_check
  CHECK (
    template_key IN (
      'certificate_completed_internship',
      'certificate_completed_research',
      'completion_letter_completed_internship'
    )
  );

ALTER TABLE dc_document_template_versions
  DROP CONSTRAINT IF EXISTS dc_document_template_versions_page_check;

ALTER TABLE dc_document_template_versions
  ADD CONSTRAINT dc_document_template_versions_page_check
  CHECK (
    (page_width = 842.25 AND page_height = 595.50)
    OR (page_width = 595.32 AND page_height = 841.92)
  );

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
VALUES (
  'DCTPL-COMPLETE-MAGANG-01',
  'DCDEF-COMPLETE-NORMAL-01',
  'completion_letter_completed_internship',
  'Surat Keterangan Selesai Magang',
  'Magang',
  'completed',
  'draft',
  '{}'::jsonb,
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
