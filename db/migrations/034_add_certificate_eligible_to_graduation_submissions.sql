-- Migration 034: Add certificate_eligible column to graduation_submissions
ALTER TABLE graduation_submissions
  ADD COLUMN IF NOT EXISTS certificate_eligible BOOLEAN NOT NULL DEFAULT TRUE;
