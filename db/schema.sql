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
  fakultas TEXT,
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
  attachment_link TEXT,
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

CREATE TABLE IF NOT EXISTS research_board_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'TO DO'
    CHECK (status IN ('TO DO', 'DOING', 'REVIEW', 'DONE')),
  deadline DATE,
  priority TEXT,
  tag TEXT,
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS research_board_task_assignees (
  task_id TEXT NOT NULL REFERENCES research_board_tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, user_id)
);

CREATE TABLE IF NOT EXISTS research_board_task_subtasks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES research_board_tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS research_board_task_attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES research_board_tasks(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size BIGINT,
  mime_type TEXT,
  uploaded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS research_board_task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES research_board_tasks(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
  requester_type TEXT NOT NULL DEFAULT 'student' CHECK (requester_type IN ('student', 'lecturer')),
  requester_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  jenis TEXT NOT NULL,
  tanggal DATE NOT NULL,
  tujuan TEXT NOT NULL,
  project_id TEXT REFERENCES research_projects(id) ON DELETE SET NULL,
  catatan TEXT,
  status TEXT NOT NULL CHECK (status IN ('Menunggu', 'Diproses', 'Siap Unduh')),
  estimasi DATE,
  nomor_surat TEXT,
  file_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS letter_database (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Lainnya',
  number TEXT,
  date DATE,
  description TEXT,
  file_url TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
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
  file_url TEXT,
  file_name TEXT,
  file_size BIGINT,
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

CREATE TABLE IF NOT EXISTS draft_reports (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES research_projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('Laporan TA', 'Jurnal', 'Laporan Kemajuan')),
  upload_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL CHECK (status IN ('Menunggu Review', 'Dalam Review', 'Disetujui')) DEFAULT 'Menunggu Review',
  comment TEXT,
  version TEXT NOT NULL DEFAULT 'v1.0',
  file_url TEXT,
  file_name TEXT,
  file_size BIGINT,
  mime_type TEXT,
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  check_out_accuracy_meters DOUBLE PRECISION,
  checkout_source TEXT,
  auto_checkout BOOLEAN NOT NULL DEFAULT FALSE,
  auto_checkout_reason TEXT,
  note TEXT,
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

CREATE TABLE IF NOT EXISTS dashboard_reminder_logs (
  id TEXT PRIMARY KEY,
  recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('logbook_missing', 'attendance_absent', 'low_hours')),
  reference_date DATE,
  reference_period TEXT,
  notification_id TEXT,
  sent_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dashboard_warning_reviews (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('logbook_missing', 'attendance_absent', 'low_hours')),
  reference_date DATE,
  reference_period TEXT,
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  review_note TEXT,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_dispatch_logs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reference_key TEXT NOT NULL,
  schedule_slot TEXT,
  notification_id TEXT,
  payload JSONB,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, recipient_user_id, reference_key, schedule_slot)
);

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  advisor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status_operator TEXT NOT NULL DEFAULT 'Menunggu'
    CHECK (status_operator IN ('Menunggu', 'Diteruskan', 'Ditolak')),
  operator_reviewed_at TIMESTAMPTZ,
  operator_reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  operator_note TEXT,
  status_dosen TEXT
    CHECK (status_dosen IN ('Menunggu', 'Disetujui', 'Ditolak')),
  advisor_reviewed_at TIMESTAMPTZ,
  advisor_reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  advisor_note TEXT,
  final_status TEXT NOT NULL DEFAULT 'Menunggu'
    CHECK (final_status IN ('Menunggu', 'Ditolak Operator', 'Menunggu Dosen', 'Ditolak Dosen', 'Disetujui')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status);
CREATE INDEX IF NOT EXISTS idx_letter_requests_status ON letter_requests(status);
CREATE INDEX IF NOT EXISTS idx_certificate_requests_status ON certificate_requests(status);
CREATE INDEX IF NOT EXISTS idx_research_board_tasks_project_status ON research_board_tasks(project_id, status, sort_order ASC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_board_tasks_project_updated ON research_board_tasks(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_board_subtasks_task ON research_board_task_subtasks(task_id, sort_order ASC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_research_board_attachments_task ON research_board_task_attachments(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_board_comments_task ON research_board_task_comments(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logbook_entries_student_date ON logbook_entries(student_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_logbook_comments_entry_created ON logbook_comments(logbook_entry_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_draft_reports_student_upload ON draft_reports(student_id, upload_date DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_records_student_date ON attendance_records(student_id, attendance_date DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_logged_at ON audit_logs(logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created ON notifications(recipient_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dashboard_reminders_student_date ON dashboard_reminder_logs(student_id, type, reference_date, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_dashboard_reminders_student_period ON dashboard_reminder_logs(student_id, type, reference_period, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_dashboard_reminders_recipient_sent ON dashboard_reminder_logs(recipient_user_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_dashboard_warning_reviews_student_date ON dashboard_warning_reviews(student_id, type, reference_date, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_dashboard_warning_reviews_student_period ON dashboard_warning_reviews(student_id, type, reference_period, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_dashboard_warning_reviews_reviewer ON dashboard_warning_reviews(reviewed_by, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_dispatch_event_recipient ON notification_dispatch_logs(event_id, recipient_user_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_student ON withdrawal_requests(student_id);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_advisor ON withdrawal_requests(advisor_id);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_final_status ON withdrawal_requests(final_status);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_submitted ON withdrawal_requests(submitted_at DESC);

COMMIT;
