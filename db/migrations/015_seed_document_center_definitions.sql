BEGIN;

INSERT INTO dc_document_definitions (
  id,
  type_code,
  type_name,
  name,
  document_purpose,
  request_mode,
  activity_type,
  can_be_collective,
  requires_project,
  requires_period,
  is_active
)
VALUES
  (
    'DCDEF-INTRO-01',
    '15',
    'Surat Pengantar',
    'Surat Pengantar',
    'introductory_letter',
    'student_request',
    'general',
    TRUE,
    FALSE,
    TRUE,
    TRUE
  ),
  (
    'DCDEF-ACCEPT-01',
    '04',
    'Surat Pemberitahuan',
    'Surat Penerimaan',
    'acceptance_letter',
    'operator_only',
    'general',
    TRUE,
    FALSE,
    TRUE,
    TRUE
  ),
  (
    'DCDEF-COMPLETE-NORMAL-01',
    '09',
    'Surat Keterangan',
    'Surat Keterangan Selesai — Normal',
    'completion_letter',
    'alumni_sync',
    'general',
    FALSE,
    FALSE,
    TRUE,
    TRUE
  ),
  (
    'DCDEF-COMPLETE-EARLY-01',
    '09',
    'Surat Keterangan',
    'Surat Keterangan Kegiatan — Early Exit',
    'completion_letter',
    'early_exit_review',
    'general',
    FALSE,
    FALSE,
    TRUE,
    TRUE
  ),
  (
    'DCDEF-CERT-NORMAL-01',
    '13',
    'Sertifikat',
    'Sertifikat — Normal',
    'certificate',
    'alumni_sync',
    'general',
    FALSE,
    TRUE,
    TRUE,
    TRUE
  ),
  (
    'DCDEF-CERT-EARLY-01',
    '13',
    'Sertifikat',
    'Sertifikat Partisipasi — Early Exit',
    'certificate',
    'early_exit_review',
    'general',
    FALSE,
    TRUE,
    TRUE,
    TRUE
  )
ON CONFLICT (id) DO NOTHING;

COMMIT;
