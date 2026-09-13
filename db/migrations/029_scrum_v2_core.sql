BEGIN;

CREATE TABLE IF NOT EXISTS research_divisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_research_divisions_project_name_ci
ON research_divisions(project_id, LOWER(name));

CREATE INDEX IF NOT EXISTS idx_research_divisions_project_active_sort
ON research_divisions(project_id, is_active, sort_order, name);

CREATE TABLE IF NOT EXISTS research_sprints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  goal TEXT,
  start_date DATE,
  end_date DATE,
  status TEXT NOT NULL DEFAULT 'planning',
  review_started_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE research_sprints
  ADD COLUMN IF NOT EXISTS review_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

DO $$
DECLARE
  constraint_record RECORD;
BEGIN
  FOR constraint_record IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'research_sprints'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE research_sprints DROP CONSTRAINT %I', constraint_record.conname);
  END LOOP;
END
$$;

UPDATE research_sprints
SET status = 'closed',
    closed_at = COALESCE(closed_at, updated_at, NOW()),
    updated_at = NOW()
WHERE status = 'completed';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'research_sprints'::regclass
      AND conname = 'research_sprints_status_check'
  ) THEN
    ALTER TABLE research_sprints
      ADD CONSTRAINT research_sprints_status_check
      CHECK (status IN ('planning', 'active', 'review', 'closed'));
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_research_sprints_one_active_per_project
ON research_sprints(project_id)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_research_sprints_project
ON research_sprints(project_id, status, created_at DESC);

ALTER TABLE research_board_tasks
  ADD COLUMN IF NOT EXISTS division_id TEXT,
  ADD COLUMN IF NOT EXISTS sprint_id TEXT,
  ADD COLUMN IF NOT EXISTS story_points INTEGER DEFAULT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'research_board_tasks'::regclass
      AND conname = 'research_board_tasks_division_id_fkey'
  ) THEN
    ALTER TABLE research_board_tasks
      ADD CONSTRAINT research_board_tasks_division_id_fkey
      FOREIGN KEY (division_id) REFERENCES research_divisions(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'research_board_tasks'::regclass
      AND conname = 'research_board_tasks_sprint_id_fkey'
  ) THEN
    ALTER TABLE research_board_tasks
      ADD CONSTRAINT research_board_tasks_sprint_id_fkey
      FOREIGN KEY (sprint_id) REFERENCES research_sprints(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_research_board_tasks_project_division_status_sort
ON research_board_tasks(project_id, division_id, status, sort_order);

CREATE INDEX IF NOT EXISTS idx_research_board_tasks_sprint
ON research_board_tasks(sprint_id);

CREATE TABLE IF NOT EXISTS research_sprint_task_assignments (
  id TEXT PRIMARY KEY,
  sprint_id TEXT NOT NULL REFERENCES research_sprints(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES research_board_tasks(id) ON DELETE CASCADE,
  division_id_at_assignment TEXT,
  division_name_at_assignment TEXT,
  story_points_at_assignment INTEGER,
  status_at_assignment TEXT,
  status_at_close TEXT,
  progress_at_close INTEGER,
  outcome TEXT NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'done', 'carry_over', 'backlog', 'cancelled')),
  target_sprint_id TEXT REFERENCES research_sprints(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  UNIQUE(sprint_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_research_sprint_task_assignments_task
ON research_sprint_task_assignments(task_id, assigned_at DESC);

CREATE INDEX IF NOT EXISTS idx_research_sprint_task_assignments_sprint_outcome
ON research_sprint_task_assignments(sprint_id, outcome, assigned_at);

INSERT INTO research_sprint_task_assignments (
  id,
  sprint_id,
  task_id,
  division_id_at_assignment,
  division_name_at_assignment,
  story_points_at_assignment,
  status_at_assignment
)
SELECT
  'SPRINT-TASK-' || MD5(task.sprint_id || ':' || task.id),
  task.sprint_id,
  task.id,
  task.division_id,
  division.name,
  task.story_points,
  task.status
FROM research_board_tasks task
LEFT JOIN research_divisions division ON division.id = task.division_id
WHERE task.sprint_id IS NOT NULL
ON CONFLICT (sprint_id, task_id) DO NOTHING;

COMMIT;
