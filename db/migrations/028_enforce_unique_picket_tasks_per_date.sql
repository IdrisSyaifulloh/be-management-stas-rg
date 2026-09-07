BEGIN;

LOCK TABLE picket_schedules IN ACCESS EXCLUSIVE MODE;

-- Constraint tidak mungkin dipenuhi tanpa mengubah histori apabila dua jadwal
-- yang saling bentrok sama-sama sudah mempunyai submission. Hentikan migration
-- secara atomik supaya submission tidak pernah dihapus atau dipindahkan.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM picket_schedules psch
    JOIN picket_submissions psub
      ON psub.schedule_id = psch.id OR psub.assignment_id = psch.id
    GROUP BY psch.schedule_date, psch.student_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Tidak dapat memperbaiki duplikasi jadwal mahasiswa: terdapat lebih dari satu jadwal dengan submission pada tanggal dan mahasiswa yang sama.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM picket_schedules psch
    JOIN picket_submissions psub
      ON psub.schedule_id = psch.id OR psub.assignment_id = psch.id
    WHERE psch.task_id IS NOT NULL
    GROUP BY psch.schedule_date, psch.task_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Tidak dapat memperbaiki duplikasi tugas piket: terdapat lebih dari satu jadwal dengan submission untuk tugas dan tanggal yang sama.';
  END IF;
END $$;

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
BEGIN
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
END $$;

COMMIT;
