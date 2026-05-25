BEGIN;

ALTER TABLE lecturers
  ADD COLUMN IF NOT EXISTS kode_dosen TEXT,
  ADD COLUMN IF NOT EXISTS nidn TEXT,
  ADD COLUMN IF NOT EXISTS asal_kampus TEXT,
  ADD COLUMN IF NOT EXISTS pendidikan_terakhir TEXT,
  ADD COLUMN IF NOT EXISTS kategori_dosen TEXT,
  ADD COLUMN IF NOT EXISTS jfa TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'lecturers_kode_dosen_key'
  ) THEN
    ALTER TABLE lecturers
      ADD CONSTRAINT lecturers_kode_dosen_key UNIQUE (kode_dosen);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'lecturers_nidn_key'
  ) THEN
    ALTER TABLE lecturers
      ADD CONSTRAINT lecturers_nidn_key UNIQUE (nidn);
  END IF;
END $$;

UPDATE lecturers
SET jfa = jabatan
WHERE jfa IS NULL
  AND jabatan IS NOT NULL;

COMMIT;
