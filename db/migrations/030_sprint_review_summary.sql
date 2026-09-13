BEGIN;

ALTER TABLE research_board_tasks
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'research_board_tasks'::regclass
      AND conname = 'research_board_tasks_cancelled_by_fkey'
  ) THEN
    ALTER TABLE research_board_tasks
      ADD CONSTRAINT research_board_tasks_cancelled_by_fkey
      FOREIGN KEY (cancelled_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS research_sprint_summaries (
  id TEXT PRIMARY KEY,
  sprint_id TEXT NOT NULL UNIQUE REFERENCES research_sprints(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  achievements TEXT,
  challenges TEXT,
  lessons_learned TEXT,
  next_sprint_plan TEXT,
  is_finalized BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  finalized_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS research_sprint_review_meetings (
  id TEXT PRIMARY KEY,
  sprint_id TEXT NOT NULL UNIQUE REFERENCES research_sprints(id) ON DELETE CASCADE,
  meeting_date DATE,
  start_time TIME,
  location TEXT,
  meeting_link TEXT,
  chair_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  agenda TEXT,
  notes TEXT,
  decisions TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS research_sprint_review_attendees (
  meeting_id TEXT NOT NULL REFERENCES research_sprint_review_meetings(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name_snapshot TEXT NOT NULL,
  role_snapshot TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (meeting_id, user_id)
);

CREATE TABLE IF NOT EXISTS research_sprint_member_evaluations (
  id TEXT PRIMARY KEY,
  sprint_id TEXT NOT NULL REFERENCES research_sprints(id) ON DELETE CASCADE,
  evaluated_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_completion INTEGER NOT NULL CHECK (task_completion BETWEEN 1 AND 10),
  quality INTEGER NOT NULL CHECK (quality BETWEEN 1 AND 10),
  timeliness INTEGER NOT NULL CHECK (timeliness BETWEEN 1 AND 10),
  collaboration INTEGER NOT NULL CHECK (collaboration BETWEEN 1 AND 10),
  initiative INTEGER NOT NULL CHECK (initiative BETWEEN 1 AND 10),
  overall_score NUMERIC(4,2) NOT NULL CHECK (overall_score >= 1 AND overall_score <= 10),
  notes TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sprint_id, evaluated_user_id)
);

CREATE INDEX IF NOT EXISTS idx_research_sprint_summaries_sprint ON research_sprint_summaries(sprint_id);
CREATE INDEX IF NOT EXISTS idx_research_sprint_review_meetings_sprint ON research_sprint_review_meetings(sprint_id);
CREATE INDEX IF NOT EXISTS idx_research_sprint_evaluations_sprint ON research_sprint_member_evaluations(sprint_id);
CREATE INDEX IF NOT EXISTS idx_research_sprint_evaluations_user ON research_sprint_member_evaluations(evaluated_user_id);

COMMIT;
