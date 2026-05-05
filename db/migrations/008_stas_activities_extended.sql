-- Migration 008: Extend stas_activities with additional fields
-- Adds: participants_count, notulensi file, surat file, pic_name, extended activity_form values

BEGIN;

ALTER TABLE stas_activities
  ADD COLUMN IF NOT EXISTS participants_count INTEGER,
  ADD COLUMN IF NOT EXISTS notulensi_url TEXT,
  ADD COLUMN IF NOT EXISTS notulensi_name TEXT,
  ADD COLUMN IF NOT EXISTS surat_url TEXT,
  ADD COLUMN IF NOT EXISTS surat_name TEXT,
  ADD COLUMN IF NOT EXISTS pic_name TEXT;

-- Drop old constraint and add new one with more activity_form values
ALTER TABLE stas_activities
  DROP CONSTRAINT IF EXISTS stas_activities_activity_form_check;

ALTER TABLE stas_activities
  ADD CONSTRAINT stas_activities_activity_form_check
    CHECK (activity_form IN ('meeting', 'visit_internal', 'visit_external', 'lab_test', 'lab', 'visit', 'other'));

COMMIT;
