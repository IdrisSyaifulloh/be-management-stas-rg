-- Migration: Add withdrawal_requests table for multi-level approval workflow
-- Alur: Mahasiswa submit → Operator review (Diteruskan/Ditolak) → Dosen review (Disetujui/Ditolak)
-- Jika Disetujui dosen → student.status = 'Mengundurkan Diri'

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id TEXT PRIMARY KEY,

  -- Mahasiswa yang mengajukan
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,

  -- Dosen pembimbing (diambil dari students.pembimbing saat submit)
  advisor_id TEXT REFERENCES users(id) ON DELETE SET NULL,

  -- Alasan pengunduran diri
  reason TEXT NOT NULL,

  -- Waktu pengajuan
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- === Tahap 1: Operator ===
  status_operator TEXT NOT NULL DEFAULT 'Menunggu'
    CHECK (status_operator IN ('Menunggu', 'Diteruskan', 'Ditolak')),
  operator_reviewed_at TIMESTAMPTZ,
  operator_reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  operator_note TEXT,

  -- === Tahap 2: Dosen Pembimbing ===
  -- NULL saat belum diteruskan operator
  status_dosen TEXT
    CHECK (status_dosen IN ('Menunggu', 'Disetujui', 'Ditolak')),
  advisor_reviewed_at TIMESTAMPTZ,
  advisor_reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  advisor_note TEXT,

  -- === Status final yang digunakan frontend untuk render progress bar 3-tahap ===
  -- 'Menunggu'        : Baru diajukan, menunggu operator
  -- 'Ditolak Operator': Operator menolak, proses selesai
  -- 'Menunggu Dosen'  : Operator meneruskan, menunggu dosen
  -- 'Ditolak Dosen'   : Dosen menolak, proses selesai
  -- 'Disetujui'       : Dosen menyetujui, mahasiswa jadi 'Mengundurkan Diri'
  final_status TEXT NOT NULL DEFAULT 'Menunggu'
    CHECK (final_status IN ('Menunggu', 'Ditolak Operator', 'Menunggu Dosen', 'Ditolak Dosen', 'Disetujui')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index untuk query umum
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_student
  ON withdrawal_requests(student_id);

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_advisor
  ON withdrawal_requests(advisor_id);

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_final_status
  ON withdrawal_requests(final_status);

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status_operator
  ON withdrawal_requests(status_operator)
  WHERE status_operator = 'Menunggu';

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_submitted
  ON withdrawal_requests(submitted_at DESC);
