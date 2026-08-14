-- Migration: 027_add_alumni_reactivation
-- Deskripsi: 
-- 1. Tambah kolom is_archived pada graduation_submissions untuk mengarsipkan data kelulusan sebelumnya
-- 2. Ubah constraint UNIQUE pada graduation_submissions(student_id) menjadi partial index (dimana is_archived = false)
-- 3. Buat tabel reactivation_requests untuk pengajuan lanjut riset alumni

-- 1. Tambah kolom is_archived
ALTER TABLE graduation_submissions 
  ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Hapus constraint unik lama (perlu di cek namanya)
ALTER TABLE graduation_submissions 
  DROP CONSTRAINT IF EXISTS graduation_submissions_student_id_key;

-- Buat partial unique index agar mahasiswa hanya punya 1 submission aktif (belum diarsipkan)
CREATE UNIQUE INDEX IF NOT EXISTS idx_graduation_submissions_active 
  ON graduation_submissions(student_id) 
  WHERE is_archived = FALSE;

-- 3. Tabel pengajuan reaktivasi
CREATE TABLE IF NOT EXISTS reactivation_requests (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES research_projects(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'Menunggu' CHECK (status IN ('Menunggu', 'Disetujui', 'Ditolak')),
  note TEXT,
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reactivation_requests_status 
  ON reactivation_requests(status);
CREATE INDEX IF NOT EXISTS idx_reactivation_requests_student 
  ON reactivation_requests(student_id, created_at DESC);
