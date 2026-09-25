BEGIN;

-- Izinkan tugas piket yang sama diberikan kepada 2 mahasiswa atau lebih
-- jika jumlah mahasiswa lebih banyak daripada jumlah master tugas aktif.
ALTER TABLE picket_schedules
  DROP CONSTRAINT IF EXISTS picket_schedules_schedule_date_task_id_key;

DROP INDEX IF EXISTS picket_schedules_date_task_unique;

COMMIT;
