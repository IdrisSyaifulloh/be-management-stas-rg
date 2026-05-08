-- Migration: Split kolom pembimbing menjadi pembimbing_lapangan dan pembimbing_akademik

ALTER TABLE students ADD COLUMN IF NOT EXISTS pembimbing_lapangan TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS pembimbing_akademik  TEXT;

-- Migrasi data lama ke pembimbing_akademik (asumsi: data existing adalah dosen universitas)
UPDATE students
SET pembimbing_akademik = pembimbing
WHERE pembimbing IS NOT NULL
  AND pembimbing_akademik IS NULL;
