BEGIN;

ALTER TABLE picket_leave_requests
  ADD COLUMN IF NOT EXISTS replacement_schedule_id TEXT,
  ADD COLUMN IF NOT EXISTS replacement_date DATE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'picket_leave_requests_replacement_schedule_id_fkey'
      AND conrelid = 'picket_leave_requests'::regclass
  ) THEN
    ALTER TABLE picket_leave_requests
      ADD CONSTRAINT picket_leave_requests_replacement_schedule_id_fkey
      FOREIGN KEY (replacement_schedule_id)
      REFERENCES picket_schedules(id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_picket_leave_requests_replacement_schedule
  ON picket_leave_requests(replacement_schedule_id);

COMMIT;
