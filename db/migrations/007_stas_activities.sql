-- Migration: Create STAS Activities Tracking Table
-- Purpose: Track daily activities (riset, abdimas, internal) with documentation
-- Created: For Kegiatan STAS-RG database feature

BEGIN;

CREATE TABLE IF NOT EXISTS stas_activities (
  id TEXT PRIMARY KEY,
  activity_date DATE NOT NULL,
  activity_type TEXT NOT NULL CHECK (activity_type IN ('riset', 'abdimas', 'internal')),
  activity_form TEXT NOT NULL CHECK (activity_form IN ('meeting', 'visit', 'lab')),
  activity_name TEXT NOT NULL,
  agenda TEXT,
  goal TEXT,
  description_summary TEXT,
  activity_time TIME,
  location TEXT,
  participants_list TEXT,
  output TEXT,
  folder_bergkas_url TEXT,
  photo_url TEXT,
  input_by TEXT NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stas_activities_date ON stas_activities(activity_date DESC);
CREATE INDEX IF NOT EXISTS idx_stas_activities_type ON stas_activities(activity_type);
CREATE INDEX IF NOT EXISTS idx_stas_activities_input_by ON stas_activities(input_by);

COMMIT;
