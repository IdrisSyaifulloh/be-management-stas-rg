-- Migration: 001_student_periods
-- Deskripsi: Tambah tabel riwayat periode keanggotaan mahasiswa di lab.
-- Setiap mahasiswa bisa punya lebih dari satu periode (Riset / Magang),
-- masing-masing dengan tanggal mulai dan selesai.
-- Ketika semua periode sudah selesai, scheduler akan otomatis
-- mengubah students.status menjadi 'Alumni'.

CREATE TABLE IF NOT EXISTS student_periods (
  id          TEXT PRIMARY KEY,
  student_id  TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  tipe        TEXT NOT NULL CHECK (tipe IN ('Riset', 'Magang')),
  mulai       DATE NOT NULL,
  selesai     DATE,          -- NULL = periode masih berjalan
  keterangan  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_student_periods_student
  ON student_periods(student_id, mulai ASC);
