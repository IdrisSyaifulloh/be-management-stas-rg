-- Migration: Add withdrawal tracking for students
-- This adds columns to track when a student withdraws and when their account should be deleted

ALTER TABLE students 
ADD COLUMN IF NOT EXISTS withdrawal_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS scheduled_deletion_at TIMESTAMPTZ;

-- Add index for efficient querying of students pending deletion
CREATE INDEX IF NOT EXISTS idx_students_scheduled_deletion 
ON students(scheduled_deletion_at) 
WHERE scheduled_deletion_at IS NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN students.withdrawal_at IS 'Timestamp when student status was changed to Mengundurkan Diri';
COMMENT ON COLUMN students.scheduled_deletion_at IS 'Timestamp when the account will be automatically deleted (30 days after withdrawal)';
