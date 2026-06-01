BEGIN;

ALTER TABLE lecturers
  ADD COLUMN IF NOT EXISTS tanggal_persetujuan_anggota DATE;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone TEXT;

COMMIT;
