-- Migration: Notulensi rapat per proyek riset
-- Jalankan sekali terhadap database PostgreSQL yang aktif.

CREATE TABLE IF NOT EXISTS research_meeting_notes (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  meeting_date      DATE NOT NULL,
  location          TEXT,
  agenda            TEXT,
  content           TEXT NOT NULL,
  decisions         TEXT,
  next_meeting_date DATE,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS research_meeting_attendees (
  id         BIGSERIAL PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES research_meeting_notes(id) ON DELETE CASCADE,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  role_label TEXT,
  attended   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_meeting_notes_project ON research_meeting_notes(project_id);
CREATE INDEX IF NOT EXISTS idx_meeting_attendees_meeting ON research_meeting_attendees(meeting_id);
