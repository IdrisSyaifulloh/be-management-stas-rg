BEGIN;

INSERT INTO dc_document_definitions (
  id, type_code, type_name, name, document_purpose, request_mode,
  activity_type, can_be_collective, requires_project, requires_period, is_active
)
VALUES
  ('DCDEF-CATALOG-01', '01', 'Surat Keputusan', 'Surat Keputusan (SK)', 'general', 'operator_only', 'general', FALSE, FALSE, FALSE, TRUE),
  ('DCDEF-CATALOG-02', '02', 'Surat Undangan', 'Surat Undangan (SU)', 'general', 'operator_only', 'general', TRUE, FALSE, FALSE, TRUE),
  ('DCDEF-CATALOG-03', '03', 'Surat Permohonan', 'Surat Permohonan (SPM)', 'general', 'operator_only', 'general', FALSE, FALSE, FALSE, TRUE),
  ('DCDEF-CATALOG-05', '05', 'Surat Peminjaman', 'Surat Peminjaman (SPP)', 'general', 'operator_only', 'general', FALSE, FALSE, FALSE, TRUE),
  ('DCDEF-CATALOG-06', '06', 'Surat Pernyataan', 'Surat Pernyataan (SPn)', 'general', 'operator_only', 'general', FALSE, FALSE, FALSE, TRUE),
  ('DCDEF-CATALOG-07', '07', 'Surat Mandat', 'Surat Mandat (SM)', 'general', 'operator_only', 'general', FALSE, FALSE, FALSE, TRUE),
  ('DCDEF-CATALOG-08', '08', 'Surat Tugas', 'Surat Tugas (ST)', 'general', 'operator_only', 'general', TRUE, FALSE, FALSE, TRUE),
  ('DCDEF-CATALOG-10', '10', 'Surat Rekomendasi', 'Surat Rekomendasi (SR)', 'general', 'operator_only', 'general', FALSE, FALSE, FALSE, TRUE),
  ('DCDEF-CATALOG-11', '11', 'Surat Balasan', 'Surat Balasan (SB)', 'general', 'operator_only', 'general', FALSE, FALSE, FALSE, TRUE),
  ('DCDEF-CATALOG-12', '12', 'Surat Perintah Perjalanan Dinas', 'Surat Perintah Perjalanan Dinas (SPPD)', 'general', 'operator_only', 'general', FALSE, FALSE, FALSE, TRUE),
  ('DCDEF-CATALOG-14', '14', 'Perjanjian Kerja', 'Perjanjian Kerja (PK)', 'general', 'operator_only', 'general', FALSE, FALSE, FALSE, TRUE),
  ('DCDEF-CATALOG-16', '16', 'Nota', 'Nota', 'general', 'operator_only', 'general', FALSE, FALSE, FALSE, TRUE),
  ('DCDEF-CATALOG-17', '17', 'Surat Berita Acara Serah Terima', 'Surat Berita Acara Serah Terima', 'general', 'operator_only', 'general', FALSE, FALSE, FALSE, TRUE)
ON CONFLICT (id) DO UPDATE SET
  type_code = EXCLUDED.type_code,
  type_name = EXCLUDED.type_name,
  name = EXCLUDED.name,
  document_purpose = EXCLUDED.document_purpose,
  request_mode = EXCLUDED.request_mode,
  activity_type = EXCLUDED.activity_type,
  can_be_collective = EXCLUDED.can_be_collective,
  requires_project = EXCLUDED.requires_project,
  requires_period = EXCLUDED.requires_period,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

COMMIT;
