BEGIN;

ALTER TABLE picket_schedules
  ADD COLUMN IF NOT EXISTS auto_leave_request_id TEXT,
  ADD COLUMN IF NOT EXISTS auto_leave_type TEXT;

ALTER TABLE picket_leave_requests
  ADD COLUMN IF NOT EXISTS source_leave_request_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'picket_schedules_auto_leave_request_id_fkey'
      AND conrelid = 'picket_schedules'::regclass
  ) THEN
    ALTER TABLE picket_schedules
      ADD CONSTRAINT picket_schedules_auto_leave_request_id_fkey
      FOREIGN KEY (auto_leave_request_id)
      REFERENCES leave_requests(id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'picket_schedules_auto_leave_type_check'
      AND conrelid = 'picket_schedules'::regclass
  ) THEN
    ALTER TABLE picket_schedules
      ADD CONSTRAINT picket_schedules_auto_leave_type_check
      CHECK (auto_leave_type IS NULL OR auto_leave_type IN ('cuti', 'izin', 'sakit', 'wfh'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'picket_leave_requests_source_leave_request_id_fkey'
      AND conrelid = 'picket_leave_requests'::regclass
  ) THEN
    ALTER TABLE picket_leave_requests
      ADD CONSTRAINT picket_leave_requests_source_leave_request_id_fkey
      FOREIGN KEY (source_leave_request_id)
      REFERENCES leave_requests(id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END
$$;

ALTER TABLE picket_schedules
  VALIDATE CONSTRAINT picket_schedules_auto_leave_request_id_fkey;

ALTER TABLE picket_schedules
  VALIDATE CONSTRAINT picket_schedules_auto_leave_type_check;

ALTER TABLE picket_leave_requests
  VALIDATE CONSTRAINT picket_leave_requests_source_leave_request_id_fkey;

CREATE INDEX IF NOT EXISTS idx_picket_schedules_auto_leave_request
  ON picket_schedules(auto_leave_request_id);

CREATE INDEX IF NOT EXISTS idx_picket_leave_requests_source_leave
  ON picket_leave_requests(source_leave_request_id);

COMMIT;
