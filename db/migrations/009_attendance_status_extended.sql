-- Migration 009: Extend attendance_records status constraint to include WFH, Izin, Sakit, Libur
-- Schema.sql only had ('Hadir', 'Tidak Hadir', 'Cuti') but the app already uses more values.

BEGIN;

ALTER TABLE attendance_records
  DROP CONSTRAINT IF EXISTS attendance_records_status_check;

ALTER TABLE attendance_records
  ADD CONSTRAINT attendance_records_status_check
    CHECK (status IN ('Hadir', 'Tidak Hadir', 'Cuti', 'WFH', 'Izin', 'Sakit', 'Libur'));

COMMIT;
