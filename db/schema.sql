BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  initials TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('mahasiswa', 'dosen', 'operator')),
  email TEXT UNIQUE,
  password_hash TEXT,
  prodi TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nim TEXT UNIQUE NOT NULL,
  angkatan TEXT,
  phone TEXT,
  status TEXT NOT NULL CHECK (status IN ('Aktif', 'Cuti', 'Alumni', 'Mengundurkan Diri')),
  tipe TEXT NOT NULL CHECK (tipe IN ('Riset', 'Magang')),
  bergabung DATE,
  pembimbing TEXT,
  kehadiran INTEGER NOT NULL DEFAULT 0,
  total_hari INTEGER NOT NULL DEFAULT 0,
  logbook_count INTEGER NOT NULL DEFAULT 0,
  jam_minggu_ini INTEGER,
  jam_minggu_target INTEGER,
  withdrawal_at TIMESTAMPTZ,
  scheduled_deletion_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lecturers (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nip TEXT UNIQUE NOT NULL,
  departemen TEXT,
  jabatan TEXT,
  keahlian TEXT[] NOT NULL DEFAULT '{}',
  riset_dipimpin INTEGER NOT NULL DEFAULT 0,
  riset_diikuti INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('Aktif', 'Pensiun')),
  bergabung DATE,
  mahasiswa_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS research_projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  short_title TEXT,
  supervisor_lecturer_id TEXT REFERENCES lecturers(id) ON DELETE SET NULL,
  period_text TEXT,
  mitra TEXT,
  status TEXT NOT NULL CHECK (status IN ('Aktif', 'Selesai', 'Ditangguhkan')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  category TEXT,
  description TEXT,
  funding TEXT,
  repositori TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS research_milestones (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT FALSE,
  target_date DATE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS research_memberships (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_type TEXT NOT NULL CHECK (member_type IN ('Mahasiswa', 'Dosen')),
  peran TEXT,
  status TEXT NOT NULL CHECK (status IN ('Aktif', 'Nonaktif')),
  bergabung DATE,
  UNIQUE (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS board_access (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES research_projects(id) ON DELETE SET NULL,
  periode_start DATE NOT NULL,
  periode_end DATE NOT NULL,
  durasi INTEGER NOT NULL,
  alasan TEXT NOT NULL,
  catatan TEXT,
  tanggal_pengajuan DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Menunggu', 'Disetujui', 'Ditolak')),
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS letter_requests (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  jenis TEXT NOT NULL,
  tanggal DATE NOT NULL,
  tujuan TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Menunggu', 'Diproses', 'Siap Unduh')),
  estimasi DATE,
  nomor_surat TEXT,
  file_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS certificate_requests (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES research_projects(id) ON DELETE SET NULL,
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('Belum Diminta', 'Diproses', 'Terbit')),
  kontribusi_selesai_date DATE,
  request_note TEXT,
  issue_date DATE,
  certificate_number TEXT,
  file_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(student_id, project_id)
);

CREATE TABLE IF NOT EXISTS logbook_entries (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES research_projects(id) ON DELETE SET NULL,
  date DATE NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  output TEXT,
  kendala TEXT,
  has_attachment BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logbook_comments (
  id TEXT PRIMARY KEY,
  logbook_entry_id TEXT NOT NULL REFERENCES logbook_entries(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_name TEXT,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attendance_records (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  attendance_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Hadir', 'Tidak Hadir', 'Cuti')),
  check_in_at TIMESTAMPTZ,
  check_out_at TIMESTAMPTZ,
  check_in_lat DOUBLE PRECISION,
  check_in_lng DOUBLE PRECISION,
  check_out_lat DOUBLE PRECISION,
  check_out_lng DOUBLE PRECISION,
  accuracy_meters DOUBLE PRECISION,
  distance_meters DOUBLE PRECISION,
  within_radius BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, attendance_date)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_role TEXT NOT NULL CHECK (user_role IN ('Mahasiswa', 'Dosen', 'Operator')),
  action TEXT NOT NULL CHECK (action IN ('Login', 'Create', 'Update', 'Delete', 'Approve', 'Export')),
  target TEXT NOT NULL,
  ip INET,
  detail JSONB,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'pengumuman',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status);
CREATE INDEX IF NOT EXISTS idx_letter_requests_status ON letter_requests(status);
CREATE INDEX IF NOT EXISTS idx_certificate_requests_status ON certificate_requests(status);
CREATE INDEX IF NOT EXISTS idx_logbook_entries_student_date ON logbook_entries(student_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_logbook_comments_entry_created ON logbook_comments(logbook_entry_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_records_student_date ON attendance_records(student_id, attendance_date DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_logged_at ON audit_logs(logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created ON notifications(recipient_user_id, created_at DESC);

COMMIT;
