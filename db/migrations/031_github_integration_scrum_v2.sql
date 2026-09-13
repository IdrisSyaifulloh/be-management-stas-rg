BEGIN;

CREATE SEQUENCE IF NOT EXISTS research_board_task_key_seq;
ALTER TABLE research_board_tasks ADD COLUMN IF NOT EXISTS task_key TEXT;
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at NULLS FIRST, id) AS n
  FROM research_board_tasks WHERE task_key IS NULL
)
UPDATE research_board_tasks t SET task_key = 'TASK-' || n.n::text FROM numbered n WHERE t.id = n.id;
ALTER SEQUENCE research_board_task_key_seq OWNED BY NONE;
SELECT setval('research_board_task_key_seq', GREATEST(COALESCE((SELECT MAX(CASE WHEN task_key ~ '^TASK-[0-9]+$' THEN SUBSTRING(task_key FROM 6)::bigint END) FROM research_board_tasks), 1), 1), (SELECT COUNT(*) > 0 FROM research_board_tasks));
ALTER TABLE research_board_tasks ALTER COLUMN task_key SET DEFAULT ('TASK-' || nextval('research_board_task_key_seq')::text);
ALTER TABLE research_board_tasks ALTER COLUMN task_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_research_board_tasks_task_key ON research_board_tasks(task_key);

CREATE TABLE IF NOT EXISTS research_repositories (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  division_id TEXT REFERENCES research_divisions(id) ON DELETE SET NULL, provider TEXT NOT NULL DEFAULT 'github' CHECK (provider = 'github'),
  github_owner TEXT NOT NULL, github_repo TEXT NOT NULL, github_repository_id TEXT, github_installation_id TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main', is_private BOOLEAN NOT NULL DEFAULT FALSE, is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, provider, github_owner, github_repo)
);
CREATE TABLE IF NOT EXISTS research_task_repository_links (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES research_board_tasks(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES research_repositories(id) ON DELETE CASCADE, branch_name TEXT,
  pull_request_number INTEGER, link_source TEXT NOT NULL DEFAULT 'manual' CHECK (link_source IN ('manual','auto_branch','auto_commit','auto_pr')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(task_id, repository_id)
);
CREATE TABLE IF NOT EXISTS research_github_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY, event_name TEXT, repository_id TEXT REFERENCES research_repositories(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), processed_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','ignored','failed')), error_message TEXT
);
CREATE TABLE IF NOT EXISTS research_github_activities (
  id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES research_repositories(id) ON DELETE CASCADE, task_id TEXT REFERENCES research_board_tasks(id) ON DELETE SET NULL,
  delivery_id TEXT NOT NULL REFERENCES research_github_webhook_deliveries(delivery_id) ON DELETE CASCADE, activity_type TEXT NOT NULL, github_event_id TEXT,
  github_actor_login TEXT, branch_name TEXT, commit_sha TEXT, commit_message TEXT, pull_request_number INTEGER, pull_request_title TEXT,
  pull_request_state TEXT, pull_request_merged BOOLEAN, html_url TEXT, occurred_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), suggested_task_status TEXT
);
CREATE INDEX IF NOT EXISTS idx_research_repositories_project ON research_repositories(project_id, is_active);
CREATE INDEX IF NOT EXISTS idx_research_task_repository_links_task ON research_task_repository_links(task_id);
CREATE INDEX IF NOT EXISTS idx_research_github_activities_repo_time ON research_github_activities(repository_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_research_github_activities_task_time ON research_github_activities(task_id, occurred_at DESC);

COMMIT;
