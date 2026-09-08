BEGIN;

LOCK TABLE picket_schedules IN ACCESS EXCLUSIVE MODE;

-- Data sebelum tanggal ini adalah histori yang sudah berjalan sebelum aturan
-- task unik diterapkan. Jadwal historis yang memiliki submission tidak diubah.
-- Jika histori bersih, migration tetap memasang full unique constraint.

-- Untuk duplikasi mahasiswa, pertahankan jadwal dengan submission. Jika tidak
-- ada submission, prioritaskan jadwal yang direferensikan oleh izin piket lalu
-- jadwal terbaru. Hanya duplikat tanpa submission yang dihapus.
WITH ranked_student_schedules AS (
  SELECT psch.id,
         EXISTS (
           SELECT 1
           FROM picket_submissions psub
           WHERE psub.schedule_id = psch.id OR psub.assignment_id = psch.id
         ) AS has_submission,
         ROW_NUMBER() OVER (
           PARTITION BY psch.schedule_date, psch.student_id
           ORDER BY EXISTS (
                      SELECT 1
                      FROM picket_submissions psub
                      WHERE psub.schedule_id = psch.id OR psub.assignment_id = psch.id
                    ) DESC,
                    EXISTS (
                      SELECT 1
                      FROM picket_leave_requests plr
                      WHERE plr.schedule_id = psch.id
                         OR plr.replacement_schedule_id = psch.id
                    ) DESC,
                    psch.updated_at DESC,
                    psch.created_at DESC,
                    psch.id ASC
         ) AS duplicate_rank
  FROM picket_schedules psch
)
DELETE FROM picket_schedules psch
USING ranked_student_schedules ranked
WHERE psch.id = ranked.id
  AND ranked.duplicate_rank > 1
  AND ranked.has_submission = FALSE;

-- Untuk duplikasi task, jadwal dengan submission tetap utuh. Jadwal duplikat
-- lain dipertahankan tetapi task-nya dikosongkan agar dapat ditugaskan ulang
-- secara manual tanpa kehilangan histori jadwal.
WITH ranked_task_schedules AS (
  SELECT psch.id,
         EXISTS (
           SELECT 1
           FROM picket_submissions psub
           WHERE psub.schedule_id = psch.id OR psub.assignment_id = psch.id
         ) AS has_submission,
         ROW_NUMBER() OVER (
           PARTITION BY psch.schedule_date, psch.task_id
           ORDER BY EXISTS (
                      SELECT 1
                      FROM picket_submissions psub
                      WHERE psub.schedule_id = psch.id OR psub.assignment_id = psch.id
                    ) DESC,
                    EXISTS (
                      SELECT 1
                      FROM picket_leave_requests plr
                      WHERE plr.schedule_id = psch.id
                         OR plr.replacement_schedule_id = psch.id
                    ) DESC,
                    psch.updated_at DESC,
                    psch.created_at DESC,
                    psch.id ASC
         ) AS duplicate_rank
  FROM picket_schedules psch
  WHERE psch.task_id IS NOT NULL
)
UPDATE picket_schedules psch
SET task_id = NULL,
    updated_at = NOW()
FROM ranked_task_schedules ranked
WHERE psch.id = ranked.id
  AND ranked.duplicate_rank > 1
  AND ranked.has_submission = FALSE;

DO $$
DECLARE
  cutover_date CONSTANT DATE := DATE '2026-09-05';
BEGIN
  -- Konflik sejak cutover tidak boleh dikecualikan. Rollback bila masih ada,
  -- termasuk bila dua jadwal yang konflik sama-sama memiliki submission.
  IF EXISTS (
    SELECT 1
    FROM picket_schedules
    WHERE schedule_date >= cutover_date
    GROUP BY schedule_date, student_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Masih terdapat duplikasi mahasiswa sejak tanggal cutover %.', cutover_date;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM picket_schedules
    WHERE schedule_date >= cutover_date
      AND task_id IS NOT NULL
    GROUP BY schedule_date, task_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Masih terdapat duplikasi tugas piket sejak tanggal cutover %.', cutover_date;
  END IF;

  -- Gunakan full constraint jika seluruh histori sudah unik. Bila konflik yang
  -- tersisa hanya histori submission sebelum cutover, gunakan partial unique
  -- index sehingga histori tetap utuh tetapi semua jadwal baru dikunci DB.
  IF NOT EXISTS (
    SELECT 1
    FROM picket_schedules
    GROUP BY schedule_date, student_id
    HAVING COUNT(*) > 1
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'picket_schedules'::regclass
        AND conname = 'picket_schedules_schedule_date_student_id_key'
    ) THEN
      ALTER TABLE picket_schedules
        ADD CONSTRAINT picket_schedules_schedule_date_student_id_key
        UNIQUE (schedule_date, student_id);
    END IF;
  ELSE
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS picket_schedules_date_student_unique '
      'ON picket_schedules (schedule_date, student_id) WHERE schedule_date >= %L::date',
      cutover_date
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM picket_schedules
    WHERE task_id IS NOT NULL
    GROUP BY schedule_date, task_id
    HAVING COUNT(*) > 1
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'picket_schedules'::regclass
        AND conname = 'picket_schedules_schedule_date_task_id_key'
    ) THEN
      ALTER TABLE picket_schedules
        ADD CONSTRAINT picket_schedules_schedule_date_task_id_key
        UNIQUE (schedule_date, task_id);
    END IF;
  ELSE
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS picket_schedules_date_task_unique '
      'ON picket_schedules (schedule_date, task_id) WHERE schedule_date >= %L::date',
      cutover_date
    );
  END IF;
END $$;

COMMIT;
