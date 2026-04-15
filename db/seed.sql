-- db/seed.sql
-- Password default untuk seluruh akun seed: 12345678
-- Hash bcrypt berikut valid untuk password 12345678
-- Seluruh insert dibuat idempotent sejauh mungkin agar aman dijalankan berulang

BEGIN;

-- ======================================================
-- USERS
-- ======================================================
INSERT INTO users (id, name, initials, role, email, password_hash, prodi, is_active)
VALUES
  ('OP001', 'idrssyfllh', 'IDR', 'operator', 'idrssyfllh@seed.stasrg.local', '$2b$10$qnonB3nNMhreydndysp30efL9XjNElVVApzEum4IdIsGh84qtl.o6', 'Umum', TRUE),
  ('OP002', 'irham', 'IRH', 'operator', 'irham@seed.stasrg.local', '$2b$10$qnonB3nNMhreydndysp30efL9XjNElVVApzEum4IdIsGh84qtl.o6', 'Umum', TRUE),
  ('OP003', 'rey', 'REY', 'operator', 'rey@seed.stasrg.local', '$2b$10$qnonB3nNMhreydndysp30efL9XjNElVVApzEum4IdIsGh84qtl.o6', 'Umum', TRUE),
  ('SEED-USR-DOS-001', 'Dr. Ahmad Fauzi', 'AF', 'dosen', 'ahmad.fauzi@seed.stasrg.local', '$2b$10$qnonB3nNMhreydndysp30efL9XjNElVVApzEum4IdIsGh84qtl.o6', 'Teknik Informatika', TRUE),
  ('SEED-USR-DOS-002', 'Siti Nurhaliza, M.Kom', 'SN', 'dosen', 'siti.nurhaliza@seed.stasrg.local', '$2b$10$qnonB3nNMhreydndysp30efL9XjNElVVApzEum4IdIsGh84qtl.o6', 'Sistem Informasi', TRUE),
  ('SEED-USR-DOS-003', 'Bima Prakoso, Ph.D', 'BP', 'dosen', 'bima.prakoso@seed.stasrg.local', '$2b$10$qnonB3nNMhreydndysp30efL9XjNElVVApzEum4IdIsGh84qtl.o6', 'Data Science', TRUE),
  ('SEED-USR-MHS-001', 'Alya Putri Ramadhani', 'APR', 'mahasiswa', 'alya.ramadhani@seed.stasrg.local', '$2b$10$qnonB3nNMhreydndysp30efL9XjNElVVApzEum4IdIsGh84qtl.o6', 'Informatika', TRUE),
  ('SEED-USR-MHS-002', 'Rizky Maulana', 'RM', 'mahasiswa', 'rizky.maulana@seed.stasrg.local', '$2b$10$qnonB3nNMhreydndysp30efL9XjNElVVApzEum4IdIsGh84qtl.o6', 'Sistem Informasi', TRUE),
  ('SEED-USR-MHS-003', 'Nabila Safitri', 'NS', 'mahasiswa', 'nabila.safitri@seed.stasrg.local', '$2b$10$qnonB3nNMhreydndysp30efL9XjNElVVApzEum4IdIsGh84qtl.o6', 'Teknik Informatika', TRUE),
  ('SEED-USR-MHS-004', 'Muhammad Idris', 'MI', 'mahasiswa', 'muhammad.idris@seed.stasrg.local', '$2b$10$qnonB3nNMhreydndysp30efL9XjNElVVApzEum4IdIsGh84qtl.o6', 'Teknik Komputer', TRUE),
  ('SEED-USR-MHS-005', 'Dea Lestari', 'DL', 'mahasiswa', 'dea.lestari@seed.stasrg.local', '$2b$10$qnonB3nNMhreydndysp30efL9XjNElVVApzEum4IdIsGh84qtl.o6', 'Informatika', TRUE),
  ('SEED-USR-MHS-006', 'Fajar Nugraha', 'FN', 'mahasiswa', 'fajar.nugraha@seed.stasrg.local', '$2b$10$qnonB3nNMhreydndysp30efL9XjNElVVApzEum4IdIsGh84qtl.o6', 'Informatika', TRUE)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  initials = EXCLUDED.initials,
  role = EXCLUDED.role,
  email = EXCLUDED.email,
  password_hash = EXCLUDED.password_hash,
  prodi = EXCLUDED.prodi,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

-- ======================================================
-- LECTURERS
-- ======================================================
INSERT INTO lecturers (
  id, user_id, nip, departemen, jabatan, keahlian,
  riset_dipimpin, riset_diikuti, status, bergabung, mahasiswa_count
)
VALUES
  ('SEED-LEC-001', 'SEED-USR-DOS-001', '8800012026001', 'Informatika', 'Lektor Kepala', ARRAY['Machine Learning', 'Data Science', 'Artificial Intelligence'], 2, 2, 'Aktif', '2010-01-01', 3),
  ('SEED-LEC-002', 'SEED-USR-DOS-002', '8800012026002', 'Sistem Informasi', 'Lektor', ARRAY['Software Engineering', 'Frontend Engineering', 'Project Management'], 1, 2, 'Aktif', '2015-04-02', 2),
  ('SEED-LEC-003', 'SEED-USR-DOS-003', '8800012026003', 'Data Science', 'Asisten Ahli', ARRAY['Learning Analytics', 'Computer Vision', 'Research Methodology'], 0, 1, 'Aktif', '2018-03-18', 1)
ON CONFLICT (id) DO UPDATE SET
  user_id = EXCLUDED.user_id,
  nip = EXCLUDED.nip,
  departemen = EXCLUDED.departemen,
  jabatan = EXCLUDED.jabatan,
  keahlian = EXCLUDED.keahlian,
  riset_dipimpin = EXCLUDED.riset_dipimpin,
  riset_diikuti = EXCLUDED.riset_diikuti,
  status = EXCLUDED.status,
  bergabung = EXCLUDED.bergabung,
  mahasiswa_count = EXCLUDED.mahasiswa_count,
  updated_at = NOW();

-- ======================================================
-- STUDENTS
-- ======================================================
INSERT INTO students (
  id, user_id, nim, angkatan, phone, status, tipe, bergabung, pembimbing,
  kehadiran, total_hari, logbook_count, jam_minggu_ini, jam_minggu_target,
  withdrawal_at, scheduled_deletion_at
)
VALUES
  ('SEED-STD-001', 'SEED-USR-MHS-001', '2200010001', '2022', '081111111001', 'Aktif', 'Riset', '2022-09-01', 'Dr. Ahmad Fauzi', 3, 4, 2, 12, 20, NULL, NULL),
  ('SEED-STD-002', 'SEED-USR-MHS-002', '2200010002', '2022', '081111111002', 'Aktif', 'Riset', '2022-09-01', 'Dr. Ahmad Fauzi', 2, 3, 2, 10, 20, NULL, NULL),
  ('SEED-STD-003', 'SEED-USR-MHS-003', '2200010003', '2023', '081111111003', 'Aktif', 'Magang', '2023-09-01', 'Siti Nurhaliza, M.Kom', 2, 2, 1, 45, 45, NULL, NULL),
  ('SEED-STD-004', 'SEED-USR-MHS-004', '2200010004', '2022', '081111111004', 'Cuti', 'Riset', '2022-09-01', 'Siti Nurhaliza, M.Kom', 1, 2, 1, 4, 20, NULL, NULL),
  ('SEED-STD-005', 'SEED-USR-MHS-005', '2200010005', '2021', '081111111005', 'Alumni', 'Riset', '2021-09-01', 'Dr. Ahmad Fauzi', 5, 5, 3, 0, 0, NULL, NULL),
  ('SEED-STD-006', 'SEED-USR-MHS-006', '2200010006', '2023', '081111111006', 'Mengundurkan Diri', 'Riset', '2023-09-01', 'Bima Prakoso, Ph.D', 0, 1, 0, 0, 20, '2026-04-01 09:00:00+07', '2026-05-01 09:00:00+07')
ON CONFLICT (id) DO UPDATE SET
  user_id = EXCLUDED.user_id,
  nim = EXCLUDED.nim,
  angkatan = EXCLUDED.angkatan,
  phone = EXCLUDED.phone,
  status = EXCLUDED.status,
  tipe = EXCLUDED.tipe,
  bergabung = EXCLUDED.bergabung,
  pembimbing = EXCLUDED.pembimbing,
  kehadiran = EXCLUDED.kehadiran,
  total_hari = EXCLUDED.total_hari,
  logbook_count = EXCLUDED.logbook_count,
  jam_minggu_ini = EXCLUDED.jam_minggu_ini,
  jam_minggu_target = EXCLUDED.jam_minggu_target,
  withdrawal_at = EXCLUDED.withdrawal_at,
  scheduled_deletion_at = EXCLUDED.scheduled_deletion_at,
  updated_at = NOW();

-- ======================================================
-- RESEARCH PROJECTS
-- ======================================================
INSERT INTO research_projects (
  id, title, short_title, supervisor_lecturer_id, period_text, mitra,
  status, progress, category, description, funding, repositori
)
VALUES
  ('SEED-PRJ-001', 'Dashboard Analitik Kinerja Mahasiswa Penelitian', 'RG Analytics', 'SEED-LEC-001', '2025/2026', 'Fakultas Informatika', 'Aktif', 40, 'Data Analytics', 'Pengembangan dashboard monitoring progres mahasiswa penelitian berbasis data historis.', 'HIBAH INTERNAL', 'https://github.com/stas-rg/rg-analytics'),
  ('SEED-PRJ-002', 'Platform Monitoring Logbook Cerdas', 'Smart Logbook', 'SEED-LEC-002', '2025/2026', 'Laboratorium Rekayasa Perangkat Lunak', 'Aktif', 70, 'Software Engineering', 'Platform logbook dengan validasi kualitas isian, monitoring, dan notifikasi otomatis.', 'MANDIRI DOSEN', 'https://github.com/stas-rg/smart-logbook'),
  ('SEED-PRJ-003', 'Prediksi Risiko Keterlambatan Akademik', 'Risk Predictor', 'SEED-LEC-001', '2024/2025', 'Pusat Data Kampus', 'Selesai', 100, 'Machine Learning', 'Model prediksi keterlambatan berbasis pola kehadiran, logbook, dan aktivitas riset mahasiswa.', 'KERJA SAMA INDUSTRI', 'https://github.com/stas-rg/risk-predictor')
ON CONFLICT (id) DO UPDATE SET
  title = EXCLUDED.title,
  short_title = EXCLUDED.short_title,
  supervisor_lecturer_id = EXCLUDED.supervisor_lecturer_id,
  period_text = EXCLUDED.period_text,
  mitra = EXCLUDED.mitra,
  status = EXCLUDED.status,
  progress = EXCLUDED.progress,
  category = EXCLUDED.category,
  description = EXCLUDED.description,
  funding = EXCLUDED.funding,
  repositori = EXCLUDED.repositori,
  updated_at = NOW();

-- ======================================================
-- RESEARCH MILESTONES
-- ======================================================
INSERT INTO research_milestones (project_id, label, done, target_date, sort_order)
SELECT v.project_id, v.label, v.done, v.target_date::date, v.sort_order
FROM (
  VALUES
    ('SEED-PRJ-001', 'Pengumpulan kebutuhan dashboard', TRUE, '2026-02-10', 1),
    ('SEED-PRJ-001', 'Implementasi visualisasi ringkasan', TRUE, '2026-03-05', 2),
    ('SEED-PRJ-001', 'Integrasi export dan monitoring', FALSE, '2026-04-20', 3),
    ('SEED-PRJ-002', 'Desain arsitektur logbook', TRUE, '2026-01-15', 1),
    ('SEED-PRJ-002', 'Pengembangan modul notifikasi', TRUE, '2026-03-01', 2),
    ('SEED-PRJ-002', 'Uji coba pengguna', FALSE, '2026-04-30', 3),
    ('SEED-PRJ-003', 'Training model baseline', TRUE, '2025-07-15', 1),
    ('SEED-PRJ-003', 'Evaluasi model final', TRUE, '2025-10-01', 2)
) AS v(project_id, label, done, target_date, sort_order)
WHERE NOT EXISTS (
  SELECT 1
  FROM research_milestones rm
  WHERE rm.project_id = v.project_id
    AND rm.label = v.label
    AND rm.sort_order = v.sort_order
);

-- ======================================================
-- RESEARCH MEMBERSHIPS
-- ======================================================
INSERT INTO research_memberships (project_id, user_id, member_type, peran, status, bergabung)
VALUES
  ('SEED-PRJ-001', 'SEED-USR-DOS-001', 'Dosen', 'Ketua Peneliti', 'Aktif', '2025-09-01'),
  ('SEED-PRJ-001', 'SEED-USR-DOS-002', 'Dosen', 'Anggota Dosen', 'Aktif', '2025-09-02'),
  ('SEED-PRJ-001', 'SEED-USR-MHS-001', 'Mahasiswa', 'Programmer Dashboard', 'Aktif', '2025-09-05'),
  ('SEED-PRJ-001', 'SEED-USR-MHS-002', 'Mahasiswa', 'Data Analyst', 'Aktif', '2025-09-05'),
  ('SEED-PRJ-002', 'SEED-USR-DOS-002', 'Dosen', 'Ketua Peneliti', 'Aktif', '2025-09-01'),
  ('SEED-PRJ-002', 'SEED-USR-DOS-003', 'Dosen', 'Anggota Dosen', 'Aktif', '2025-09-03'),
  ('SEED-PRJ-002', 'SEED-USR-MHS-003', 'Mahasiswa', 'Frontend Engineer', 'Aktif', '2025-09-08'),
  ('SEED-PRJ-002', 'SEED-USR-MHS-004', 'Mahasiswa', 'QA & Dokumentasi', 'Aktif', '2025-09-10'),
  ('SEED-PRJ-003', 'SEED-USR-DOS-001', 'Dosen', 'Ketua Peneliti', 'Aktif', '2024-02-01'),
  ('SEED-PRJ-003', 'SEED-USR-MHS-005', 'Mahasiswa', 'Research Assistant', 'Nonaktif', '2024-02-10')
ON CONFLICT (project_id, user_id) DO UPDATE SET
  member_type = EXCLUDED.member_type,
  peran = EXCLUDED.peran,
  status = EXCLUDED.status,
  bergabung = EXCLUDED.bergabung;

-- ======================================================
-- BOARD ACCESS
-- ======================================================
INSERT INTO board_access (project_id, user_id)
VALUES
  ('SEED-PRJ-001', 'SEED-USR-MHS-001'),
  ('SEED-PRJ-001', 'SEED-USR-MHS-002'),
  ('SEED-PRJ-002', 'SEED-USR-MHS-003'),
  ('SEED-PRJ-002', 'SEED-USR-DOS-003'),
  ('SEED-PRJ-003', 'SEED-USR-OP-001')
ON CONFLICT (project_id, user_id) DO NOTHING;

-- ======================================================
-- LEAVE REQUESTS
-- ======================================================
INSERT INTO leave_requests (
  id, student_id, project_id, periode_start, periode_end, durasi, alasan, catatan,
  tanggal_pengajuan, status, reviewed_by, reviewed_at, review_note
)
VALUES
  ('SEED-LVR-001', 'SEED-STD-004', 'SEED-PRJ-002', '2026-03-26', '2026-03-27', 2, 'Pemulihan kondisi kesehatan', 'Sudah melampirkan surat dokter.', '2026-03-24', 'Disetujui', 'SEED-USR-DOS-002', '2026-03-24 10:30:00+07', 'Disetujui untuk pemulihan selama dua hari.'),
  ('SEED-LVR-002', 'SEED-STD-001', 'SEED-PRJ-001', '2026-04-15', '2026-04-15', 1, 'Keperluan keluarga mendadak', 'Pengganti tugas sudah diatur.', '2026-04-10', 'Menunggu', NULL, NULL, NULL),
  ('SEED-LVR-003', 'SEED-STD-002', 'SEED-PRJ-001', '2026-02-12', '2026-02-13', 2, 'Mengikuti kegiatan akademik luar kampus', 'Kegiatan resmi prodi.', '2026-02-08', 'Ditolak', 'SEED-USR-DOS-001', '2026-02-09 14:00:00+07', 'Periode kegiatan bentrok dengan target milestone.')
ON CONFLICT (id) DO UPDATE SET
  student_id = EXCLUDED.student_id,
  project_id = EXCLUDED.project_id,
  periode_start = EXCLUDED.periode_start,
  periode_end = EXCLUDED.periode_end,
  durasi = EXCLUDED.durasi,
  alasan = EXCLUDED.alasan,
  catatan = EXCLUDED.catatan,
  tanggal_pengajuan = EXCLUDED.tanggal_pengajuan,
  status = EXCLUDED.status,
  reviewed_by = EXCLUDED.reviewed_by,
  reviewed_at = EXCLUDED.reviewed_at,
  review_note = EXCLUDED.review_note,
  updated_at = NOW();

-- ======================================================
-- LETTER REQUESTS
-- ======================================================
INSERT INTO letter_requests (
  id, student_id, requester_type, requester_id, jenis, tanggal, tujuan, project_id, catatan, status, estimasi, nomor_surat, file_url
)
VALUES
  ('SEED-LTR-001', 'SEED-STD-001', 'student', 'SEED-USR-MHS-001', 'Surat Pengantar Penelitian', '2026-03-18', 'Pengajuan akses data ke fakultas', 'SEED-PRJ-001', 'Untuk kebutuhan izin akses data penelitian.', 'Siap Unduh', '2026-03-20', 'SK/2026/0001', '/uploads/letters/sk-2026-0001.pdf'),
  ('SEED-LTR-002', 'SEED-STD-003', 'student', 'SEED-USR-MHS-003', 'Surat Keterangan Aktif', '2026-04-04', 'Persyaratan beasiswa', NULL, NULL, 'Diproses', '2026-04-12', NULL, NULL),
  ('SEED-LTR-003', 'SEED-STD-004', 'student', 'SEED-USR-MHS-004', 'Surat Izin Cuti', '2026-03-23', 'Administrasi laboratorium', 'SEED-PRJ-002', 'Dipakai untuk administrasi internal laboratorium.', 'Menunggu', NULL, NULL, NULL),
  ('SEED-LTR-DSN-001', NULL, 'lecturer', 'SEED-USR-DOS-001', 'Surat Tugas', '2026-04-12', 'Pengajuan surat tugas untuk pendampingan seminar mahasiswa', 'SEED-PRJ-003', 'Pendampingan seminar hasil untuk tim Risk Predictor.', 'Menunggu', NULL, NULL, NULL)
ON CONFLICT (id) DO UPDATE SET
  student_id = EXCLUDED.student_id,
  requester_type = EXCLUDED.requester_type,
  requester_id = EXCLUDED.requester_id,
  jenis = EXCLUDED.jenis,
  tanggal = EXCLUDED.tanggal,
  tujuan = EXCLUDED.tujuan,
  project_id = EXCLUDED.project_id,
  catatan = EXCLUDED.catatan,
  status = EXCLUDED.status,
  estimasi = EXCLUDED.estimasi,
  nomor_surat = EXCLUDED.nomor_surat,
  file_url = EXCLUDED.file_url,
  updated_at = NOW();

-- ======================================================
-- CERTIFICATE REQUESTS
-- ======================================================
INSERT INTO certificate_requests (
  id, student_id, project_id, requested_by, status, kontribusi_selesai_date,
  request_note, issue_date, certificate_number, file_url
)
VALUES
  ('SEED-CRT-001', 'SEED-STD-001', 'SEED-PRJ-001', 'SEED-USR-DOS-001', 'Diproses', '2026-03-31', 'Mahasiswa menyelesaikan modul dashboard utama.', NULL, NULL, NULL),
  ('SEED-CRT-002', 'SEED-STD-005', 'SEED-PRJ-003', 'SEED-USR-DOS-001', 'Terbit', '2025-11-15', 'Kontribusi final pada evaluasi model dan dokumentasi.', '2025-12-01', 'CERT/2025/0098', '/uploads/certificates/cert-2025-0098.pdf'),
  ('SEED-CRT-003', 'SEED-STD-002', 'SEED-PRJ-001', 'SEED-USR-DOS-002', 'Belum Diminta', NULL, 'Menunggu penyelesaian analisis akhir.', NULL, NULL, NULL)
ON CONFLICT (student_id, project_id) DO UPDATE SET
  requested_by = EXCLUDED.requested_by,
  status = EXCLUDED.status,
  kontribusi_selesai_date = EXCLUDED.kontribusi_selesai_date,
  request_note = EXCLUDED.request_note,
  issue_date = EXCLUDED.issue_date,
  certificate_number = EXCLUDED.certificate_number,
  file_url = EXCLUDED.file_url,
  updated_at = NOW();

-- ======================================================
-- LOGBOOK ENTRIES
-- ======================================================
INSERT INTO logbook_entries (
  id, student_id, project_id, date, title, description, output, kendala, has_attachment, file_url, file_name, file_size
)
VALUES
  ('SEED-LGB-001', 'SEED-STD-001', 'SEED-PRJ-001', '2026-03-24', 'Integrasi modul notifikasi', 'Menambahkan event pengingat export dan menyusun alur notifikasi operator.', 'Notifikasi draft berhasil dikirim ke dashboard.', 'Sinkronisasi role access masih perlu dirapikan.', FALSE, NULL, NULL, NULL),
  ('SEED-LGB-002', 'SEED-STD-001', 'SEED-PRJ-001', '2026-03-25', 'Penyempurnaan tampilan kartu ringkasan', 'Memperbarui KPI cards dan warna status berdasarkan masukan pembimbing.', 'UI ringkasan progres lebih konsisten.', NULL, FALSE, NULL, NULL, NULL),
  ('SEED-LGB-003', 'SEED-STD-002', 'SEED-PRJ-001', '2026-03-25', 'Analisis kebutuhan export rekap', 'Menyusun skenario export CSV dan validasi filter rentang tanggal.', 'Daftar field export rekap selesai.', NULL, TRUE, '/uploads/logbooks/seed-diagram-arsitektur.png', 'diagram-arsitektur.png', 68),
  ('SEED-LGB-004', 'SEED-STD-003', 'SEED-PRJ-002', '2026-04-03', 'Implementasi form preferensi notifikasi', 'Membuat UI preferensi notifikasi dan menghubungkannya ke backend.', 'Form preferensi sudah tersimpan ke app settings.', NULL, FALSE, NULL, NULL, NULL),
  ('SEED-LGB-005', 'SEED-STD-004', 'SEED-PRJ-002', '2026-03-22', 'Dokumentasi pengajuan cuti', 'Merangkum alur pengajuan cuti dan dampaknya ke milestone tim.', 'Dokumentasi internal tim tersedia.', NULL, FALSE, NULL, NULL, NULL),
  ('SEED-LGB-006', 'SEED-STD-005', 'SEED-PRJ-003', '2025-10-22', 'Finalisasi laporan evaluasi model', 'Menutup eksperimen akhir dan menyusun laporan evaluasi confusion matrix.', 'Laporan evaluasi final terkirim.', NULL, TRUE, '/uploads/logbooks/seed-hasil-evaluasi.zip', 'hasil-evaluasi.zip', 173)
ON CONFLICT (id) DO UPDATE SET
  student_id = EXCLUDED.student_id,
  project_id = EXCLUDED.project_id,
  date = EXCLUDED.date,
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  output = EXCLUDED.output,
  kendala = EXCLUDED.kendala,
  has_attachment = EXCLUDED.has_attachment,
  file_url = EXCLUDED.file_url,
  file_name = EXCLUDED.file_name,
  file_size = EXCLUDED.file_size,
  updated_at = NOW();

-- ======================================================
-- LOGBOOK COMMENTS
-- ======================================================
INSERT INTO logbook_comments (id, logbook_entry_id, author_id, author_name, text)
VALUES
  ('SEED-CMT-001', 'SEED-LGB-001', 'SEED-USR-DOS-001', 'Dr. Ahmad Fauzi', 'Tambahkan contoh event export gagal untuk operator.'),
  ('SEED-CMT-002', 'SEED-LGB-001', 'SEED-USR-MHS-002', 'Rizky Maulana', 'Siap, saya bantu skenario validasi tanggal.'),
  ('SEED-CMT-003', 'SEED-LGB-003', 'SEED-USR-DOS-002', 'Siti Nurhaliza, M.Kom', 'Pastikan filter riset tidak muncul untuk layanan surat.'),
  ('SEED-CMT-004', 'SEED-LGB-004', 'SEED-USR-DOS-003', 'Bima Prakoso, Ph.D', 'UI preferensi sudah baik, lanjutkan pengujian.'),
  ('SEED-CMT-005', 'SEED-LGB-005', 'SEED-USR-OP-001', 'Operator Sistem', 'Dokumentasi sudah diterima, akan dipakai untuk briefing.'),
  ('SEED-CMT-006', 'SEED-LGB-006', 'SEED-USR-DOS-001', 'Dr. Ahmad Fauzi', 'Terima kasih, laporan final sudah sesuai.')
ON CONFLICT (id) DO UPDATE SET
  logbook_entry_id = EXCLUDED.logbook_entry_id,
  author_id = EXCLUDED.author_id,
  author_name = EXCLUDED.author_name,
  text = EXCLUDED.text;

-- ======================================================
-- ATTENDANCE RECORDS
-- ======================================================
INSERT INTO attendance_records (
  id, student_id, attendance_date, status, check_in_at, check_out_at,
  check_in_lat, check_in_lng, check_out_lat, check_out_lng,
  accuracy_meters, distance_meters, within_radius
)
VALUES
  ('SEED-ATT-001', 'SEED-STD-001', '2026-03-24', 'Hadir', '2026-03-24 08:02:00+07', '2026-03-24 16:01:00+07', -6.9731, 107.6301, -6.9732, 107.6302, 5.4, 12.1, TRUE),
  ('SEED-ATT-002', 'SEED-STD-001', '2026-03-25', 'Hadir', '2026-03-25 08:05:00+07', '2026-03-25 16:02:00+07', -6.9731, 107.6301, -6.9732, 107.6302, 4.8, 11.7, TRUE),
  ('SEED-ATT-003', 'SEED-STD-001', '2026-03-26', 'Tidak Hadir', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, FALSE),
  ('SEED-ATT-004', 'SEED-STD-002', '2026-03-24', 'Hadir', '2026-03-24 08:15:00+07', '2026-03-24 15:48:00+07', -6.9730, 107.6299, -6.9730, 107.6300, 6.1, 13.4, TRUE),
  ('SEED-ATT-005', 'SEED-STD-002', '2026-03-25', 'Hadir', '2026-03-25 08:11:00+07', '2026-03-25 15:42:00+07', -6.9730, 107.6299, -6.9730, 107.6300, 5.9, 10.8, TRUE),
  ('SEED-ATT-006', 'SEED-STD-003', '2026-04-03', 'Hadir', '2026-04-03 08:00:00+07', '2026-04-03 17:10:00+07', -6.9728, 107.6303, -6.9729, 107.6304, 4.1, 9.8, TRUE),
  ('SEED-ATT-007', 'SEED-STD-003', '2026-04-04', 'Hadir', '2026-04-04 08:03:00+07', '2026-04-04 17:00:00+07', -6.9728, 107.6303, -6.9729, 107.6304, 4.4, 10.2, TRUE),
  ('SEED-ATT-008', 'SEED-STD-004', '2026-03-22', 'Hadir', '2026-03-22 08:09:00+07', '2026-03-22 12:02:00+07', -6.9727, 107.6305, -6.9727, 107.6305, 7.0, 15.2, TRUE),
  ('SEED-ATT-009', 'SEED-STD-004', '2026-03-26', 'Cuti', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, FALSE),
  ('SEED-ATT-010', 'SEED-STD-005', '2025-10-20', 'Hadir', '2025-10-20 08:00:00+07', '2025-10-20 16:00:00+07', -6.9734, 107.6298, -6.9734, 107.6298, 3.9, 8.4, TRUE)
ON CONFLICT (student_id, attendance_date) DO UPDATE SET
  status = EXCLUDED.status,
  check_in_at = EXCLUDED.check_in_at,
  check_out_at = EXCLUDED.check_out_at,
  check_in_lat = EXCLUDED.check_in_lat,
  check_in_lng = EXCLUDED.check_in_lng,
  check_out_lat = EXCLUDED.check_out_lat,
  check_out_lng = EXCLUDED.check_out_lng,
  accuracy_meters = EXCLUDED.accuracy_meters,
  distance_meters = EXCLUDED.distance_meters,
  within_radius = EXCLUDED.within_radius,
  updated_at = NOW();

-- ======================================================
-- AUDIT LOGS
-- ======================================================
INSERT INTO audit_logs (id, user_id, user_role, action, target, ip, detail, logged_at)
VALUES
  ('SEED-AUD-001', 'SEED-USR-OP-001', 'Operator', 'Login', 'auth', '127.0.0.1', '{"identifier":"operator.sistem@seed.stasrg.local"}'::jsonb, '2026-04-10 08:00:00+07'),
  ('SEED-AUD-002', 'SEED-USR-DOS-001', 'Dosen', 'Approve', 'leave_request:SEED-LVR-001', '127.0.0.1', '{"status":"Disetujui"}'::jsonb, '2026-03-24 10:30:00+07'),
  ('SEED-AUD-003', 'SEED-USR-DOS-001', 'Dosen', 'Update', 'research_project:SEED-PRJ-001', '127.0.0.1', '{"field":"progress","value":40}'::jsonb, '2026-04-09 11:15:00+07'),
  ('SEED-AUD-004', 'SEED-USR-MHS-001', 'Mahasiswa', 'Create', 'logbook_entry:SEED-LGB-001', '127.0.0.1', '{"projectId":"SEED-PRJ-001"}'::jsonb, '2026-03-24 17:00:00+07'),
  ('SEED-AUD-005', 'SEED-USR-MHS-003', 'Mahasiswa', 'Create', 'letter_request:SEED-LTR-002', '127.0.0.1', '{"jenis":"Surat Keterangan Aktif"}'::jsonb, '2026-04-04 09:20:00+07'),
  ('SEED-AUD-006', 'SEED-USR-OP-002', 'Operator', 'Export', 'exports:kehadiran', '127.0.0.1', '{"format":"xlsx","type":"kehadiran"}'::jsonb, '2026-04-10 13:00:00+07'),
  ('SEED-AUD-007', 'SEED-USR-DOS-002', 'Dosen', 'Update', 'notification_preferences', '127.0.0.1', '{"recipient":"SEED-USR-MHS-003"}'::jsonb, '2026-04-05 16:10:00+07'),
  ('SEED-AUD-008', 'SEED-USR-OP-001', 'Operator', 'Create', 'notification:SEED-NTF-001', '127.0.0.1', '{"recipient":"SEED-USR-MHS-001"}'::jsonb, '2026-04-10 14:00:00+07')
ON CONFLICT (id) DO UPDATE SET
  user_id = EXCLUDED.user_id,
  user_role = EXCLUDED.user_role,
  action = EXCLUDED.action,
  target = EXCLUDED.target,
  ip = EXCLUDED.ip,
  detail = EXCLUDED.detail,
  logged_at = EXCLUDED.logged_at;

-- ======================================================
-- APP SETTINGS
-- ======================================================
INSERT INTO app_settings (setting_key, setting_value, updated_at)
VALUES
  (
    'system',
    '{
      "umum": {
        "appName": "STAS-RG MS",
        "universityName": "Telkom University",
        "academicYear": "2025/2026",
        "semester": "Genap",
        "logoDataUrl": null
      },
      "gps": {
        "latitude": -7.5571,
        "longitude": 110.8316,
        "radius": 15
      },
      "cuti": {
        "maxSemesterDays": 3,
        "maxMonthDays": 2,
        "minAttendancePct": 80,
        "period": "Genap 2025/2026"
      },
      "notif": {
        "events": [
          { "id": "logbook_reminder", "label": "Pengingat Logbook Harian", "enabled": true },
          { "id": "cuti_request", "label": "Pengajuan Cuti Masuk", "enabled": true },
          { "id": "surat_request", "label": "Permintaan Surat Masuk", "enabled": true },
          { "id": "milestone_update", "label": "Update Milestone Riset", "enabled": false },
          { "id": "low_attendance", "label": "Kehadiran Rendah (< 75%)", "enabled": true },
          { "id": "logbook_missing", "label": "Logbook Tidak Diisi 3+ Hari", "enabled": true }
        ],
        "reminder": {
          "firstTime": "09:00",
          "secondTime": "15:00",
          "deadlineTime": "23:59",
          "toleranceDays": 1
        }
      },
      "attendanceRules": {
        "risetMinWeeklyHours": 4,
        "risetTargetWeeklyHours": 6,
        "magangDailyHours": 9,
        "magangWorkDays": "5",
        "earlyCheckoutWarning": true
      }
    }'::jsonb,
    NOW()
  ),
  ('notification_prefs:SEED-USR-MHS-001', '{"items":[{"id":"logbook_reminder","enabled":true},{"id":"cuti_request","enabled":true},{"id":"milestone_update","enabled":false}]}'::jsonb, NOW()),
  ('notification_prefs:SEED-USR-MHS-003', '{"items":[{"id":"surat_request","enabled":true},{"id":"low_attendance","enabled":true}]}'::jsonb, NOW()),
  ('notification_prefs:SEED-USR-DOS-001', '{"items":[{"id":"cuti_request","enabled":true},{"id":"milestone_update","enabled":true}]}'::jsonb, NOW()),
  ('draft_report_types', '{"items":[{"id":"DRT-001","label":"Laporan TA","is_active":true,"sort_order":1},{"id":"DRT-002","label":"Jurnal","is_active":true,"sort_order":2},{"id":"DRT-003","label":"Laporan Kemajuan","is_active":true,"sort_order":3}]}'::jsonb, NOW())
ON CONFLICT (setting_key) DO UPDATE SET
  setting_value = EXCLUDED.setting_value,
  updated_at = NOW();

-- ======================================================
-- WITHDRAWAL REQUESTS
-- ======================================================
-- SEED-WDR-001 : Alya (STD-001)  → Menunggu operator
-- SEED-WDR-002 : Rizky (STD-002) → Diteruskan operator, Menunggu dosen
-- SEED-WDR-003 : Fajar (STD-006) → Disetujui (data historis, cocok dgn students.status = 'Mengundurkan Diri')
INSERT INTO withdrawal_requests (
  id, student_id, advisor_id, reason, submitted_at,
  status_operator, operator_reviewed_at, operator_reviewed_by, operator_note,
  status_dosen, advisor_reviewed_at, advisor_reviewed_by, advisor_note,
  final_status
)
VALUES
  (
    'SEED-WDR-001', 'SEED-STD-001', 'SEED-USR-DOS-001',
    'Saya memutuskan mengundurkan diri karena sudah mendapatkan pekerjaan tetap di luar kota dan tidak dapat meneruskan kegiatan penelitian.',
    '2026-04-10 09:00:00+07',
    'Menunggu', NULL, NULL, NULL,
    NULL, NULL, NULL, NULL,
    'Menunggu'
  ),
  (
    'SEED-WDR-002', 'SEED-STD-002', 'SEED-USR-DOS-001',
    'Kondisi keluarga mengharuskan saya pindah ke luar kota sehingga tidak memungkinkan untuk melanjutkan penelitian secara luring.',
    '2026-04-08 14:30:00+07',
    'Diteruskan', '2026-04-09 10:00:00+07', 'SEED-USR-OP-001', 'Data kelengkapan mahasiswa sudah sesuai. Diteruskan ke dosen pembimbing.',
    'Menunggu', NULL, NULL, NULL,
    'Menunggu Dosen'
  ),
  (
    'SEED-WDR-003', 'SEED-STD-006', 'SEED-USR-DOS-003',
    'Terdapat hambatan pribadi yang mengharuskan saya berhenti dari kegiatan penelitian.',
    '2026-03-28 11:00:00+07',
    'Diteruskan', '2026-03-29 09:30:00+07', 'SEED-USR-OP-002', 'Dokumen pendukung lengkap. Diteruskan ke dosen pembimbing.',
    'Disetujui', '2026-03-31 13:00:00+07', 'SEED-USR-DOS-003', 'Pengajuan disetujui sesuai kondisi mahasiswa yang bersangkutan.',
    'Disetujui'
  )
ON CONFLICT (id) DO UPDATE SET
  student_id            = EXCLUDED.student_id,
  advisor_id            = EXCLUDED.advisor_id,
  reason                = EXCLUDED.reason,
  submitted_at          = EXCLUDED.submitted_at,
  status_operator       = EXCLUDED.status_operator,
  operator_reviewed_at  = EXCLUDED.operator_reviewed_at,
  operator_reviewed_by  = EXCLUDED.operator_reviewed_by,
  operator_note         = EXCLUDED.operator_note,
  status_dosen          = EXCLUDED.status_dosen,
  advisor_reviewed_at   = EXCLUDED.advisor_reviewed_at,
  advisor_reviewed_by   = EXCLUDED.advisor_reviewed_by,
  advisor_note          = EXCLUDED.advisor_note,
  final_status          = EXCLUDED.final_status,
  updated_at            = NOW();

-- ======================================================
-- NOTIFICATIONS
-- ======================================================
INSERT INTO notifications (id, recipient_user_id, sender_user_id, type, title, body, read_at, created_at)
VALUES
  ('SEED-NTF-001', 'SEED-USR-MHS-001', 'SEED-USR-OP-001', 'pengumuman', 'Jadwal Review Dashboard', 'Review progres dashboard dijadwalkan pada 12 April 2026 pukul 10.00 WIB.', NULL, '2026-04-10 14:00:00+07'),
  ('SEED-NTF-002', 'SEED-USR-MHS-003', 'SEED-USR-DOS-002', 'surat', 'Pengajuan Surat Diproses', 'Pengajuan surat aktif Anda sedang diproses operator.', '2026-04-05 12:00:00+07', '2026-04-05 10:30:00+07'),
  ('SEED-NTF-003', 'SEED-USR-DOS-001', 'SEED-USR-OP-002', 'cuti', 'Pengajuan Cuti Baru', 'Terdapat pengajuan cuti baru dari Alya Putri Ramadhani.', NULL, '2026-04-10 09:00:00+07'),
  ('SEED-NTF-004', 'SEED-USR-MHS-004', 'SEED-USR-DOS-002', 'cuti', 'Pengajuan Cuti Disetujui', 'Pengajuan cuti Anda disetujui untuk periode 26-27 Maret 2026.', '2026-03-24 11:00:00+07', '2026-03-24 10:31:00+07'),
  ('SEED-NTF-005', 'SEED-USR-MHS-002', 'SEED-USR-DOS-001', 'riset', 'Target Export Baru', 'Silakan bantu validasi skenario export rekap-data sebelum Jumat.', NULL, '2026-04-09 15:20:00+07')
ON CONFLICT (id) DO UPDATE SET
  recipient_user_id = EXCLUDED.recipient_user_id,
  sender_user_id = EXCLUDED.sender_user_id,
  type = EXCLUDED.type,
  title = EXCLUDED.title,
  body = EXCLUDED.body,
  read_at = EXCLUDED.read_at,
  created_at = EXCLUDED.created_at;

COMMIT;
